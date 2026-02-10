import { describe, expect, it, vi } from "vitest";
import { FragnoId } from "../schema/create";
import { submitSyncRequest, type SyncRequestRecord, type SyncSubmitRuntime } from "./submit";
import type { OutboxEntry } from "../outbox/outbox";
import type { SyncCommandDefinition } from "./types";

const createEntry = (versionstamp: string): OutboxEntry => ({
  id: FragnoId.fromExternal(`entry-${versionstamp}`, 1),
  versionstamp,
  uowId: `uow-${versionstamp}`,
  payload: { json: { version: 1, mutations: [] } },
  createdAt: new Date(),
});

const createRuntime = (
  overrides: Partial<SyncSubmitRuntime> = {},
): {
  runtime: SyncSubmitRuntime;
  stored: SyncRequestRecord[];
  executed: string[];
} => {
  const stored: SyncRequestRecord[] = [];
  const executed: string[] = [];

  const runtime: SyncSubmitRuntime = {
    getAdapterIdentity: async () => "adapter-1",
    listOutboxEntries: async () => [],
    countOutboxMutations: async () => 0,
    getSyncRequest: async () => undefined,
    storeSyncRequest: async (record) => {
      stored.push(record);
    },
    resolveCommand: () => ({
      command: { name: "noop", handler: async () => undefined },
      namespace: "app",
    }),
    createCommandContext: () => ({}),
    executeCommand: async (command) => {
      executed.push(command.name);
    },
    ...overrides,
  };

  return { runtime, stored, executed };
};

describe("submitSyncRequest", () => {
  it("rejects adapter identity mismatches", async () => {
    const { runtime } = createRuntime({
      getAdapterIdentity: async () => "expected",
    });

    const result = await submitSyncRequest(
      {
        requestId: "req-1",
        adapterIdentity: "other",
        conflictResolutionStrategy: "server",
        commands: [
          {
            id: "cmd-1",
            name: "noop",
            target: { fragment: "alpha", schema: "alpha" },
            input: {},
          },
        ],
      },
      runtime,
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.statusCode).toBe(409);
      expect(result.body.error.code).toBe("ADAPTER_IDENTITY_MISMATCH");
    }
  });

  it("returns limit_exceeded when too many commands are submitted", async () => {
    const { runtime, stored } = createRuntime({
      maxCommandsPerSubmit: 1,
      listOutboxEntries: async () => [createEntry("000000000000000000000001")],
    });

    const result = await submitSyncRequest(
      {
        requestId: "req-2",
        adapterIdentity: "adapter-1",
        conflictResolutionStrategy: "server",
        commands: [
          {
            id: "cmd-1",
            name: "noop",
            target: { fragment: "alpha", schema: "alpha" },
            input: {},
          },
          {
            id: "cmd-2",
            name: "noop",
            target: { fragment: "alpha", schema: "alpha" },
            input: {},
          },
        ],
      },
      runtime,
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.response.status).toBe("conflict");
      if (result.response.status === "conflict") {
        expect(result.response.reason).toBe("limit_exceeded");
        expect(result.response.confirmedCommandIds).toEqual([]);
        expect(result.response.lastVersionstamp).toBe("000000000000000000000001");
      }
    }
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe("conflict");
  });

  it("returns client_far_behind when unseen mutations exceed the limit", async () => {
    const { runtime, stored } = createRuntime({
      maxUnseenMutations: 1,
      countOutboxMutations: async () => 2,
      listOutboxEntries: async () => [createEntry("000000000000000000000002")],
    });

    const result = await submitSyncRequest(
      {
        requestId: "req-3",
        adapterIdentity: "adapter-1",
        conflictResolutionStrategy: "server",
        commands: [
          {
            id: "cmd-1",
            name: "noop",
            target: { fragment: "alpha", schema: "alpha" },
            input: {},
          },
        ],
      },
      runtime,
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.response.status).toBe("conflict");
      if (result.response.status === "conflict") {
        expect(result.response.reason).toBe("client_far_behind");
        expect(result.response.lastVersionstamp).toBe("000000000000000000000002");
      }
    }
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe("conflict");
  });

  it("tracks confirmed command ids on applied requests", async () => {
    const commandDefs = new Map<string, SyncCommandDefinition>([
      ["create", { name: "create", handler: async () => undefined }],
      ["update", { name: "update", handler: async () => undefined }],
    ]);

    const executeCommand = vi.fn(async () => undefined);
    const { runtime, stored } = createRuntime({
      resolveCommand: (_fragment, _schema, name) => {
        const command = commandDefs.get(name);
        return command ? { command, namespace: "app" } : undefined;
      },
      executeCommand,
    });

    const result = await submitSyncRequest(
      {
        requestId: "req-4",
        adapterIdentity: "adapter-1",
        conflictResolutionStrategy: "server",
        commands: [
          {
            id: "cmd-1",
            name: "create",
            target: { fragment: "alpha", schema: "alpha" },
            input: { name: "First" },
          },
          {
            id: "cmd-2",
            name: "update",
            target: { fragment: "alpha", schema: "alpha" },
            input: { name: "Second" },
          },
        ],
      },
      runtime,
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.response.status).toBe("applied");
      if (result.response.status === "applied") {
        expect(result.response.confirmedCommandIds).toEqual(["cmd-1", "cmd-2"]);
      }
    }
    expect(executeCommand).toHaveBeenCalledTimes(2);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe("applied");
  });
});
