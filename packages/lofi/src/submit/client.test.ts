import { beforeEach, describe, expect, it, vi } from "vitest";
import superjson from "superjson";
import {
  IDBCursor,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRequest,
  IDBTransaction,
} from "fake-indexeddb";
import { column, idColumn, schema } from "@fragno-dev/db/schema";
import type { LofiSubmitCommandDefinition } from "../types";
import { LofiSubmitClient } from "./client";
import { IndexedDbAdapter } from "../indexeddb/adapter";
import { LofiOverlayManager } from "../optimistic/overlay-manager";

const appSchema = schema("app", (s) =>
  s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("email", column("string"))),
);

const createDbName = () => `lofi-submit-${Math.random().toString(16).slice(2)}`;

describe("LofiSubmitClient", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    globalThis.IDBCursor = IDBCursor;
    globalThis.IDBDatabase = IDBDatabase;
    globalThis.IDBIndex = IDBIndex;
    globalThis.IDBKeyRange = IDBKeyRange;
    globalThis.IDBObjectStore = IDBObjectStore;
    globalThis.IDBOpenDBRequest = IDBOpenDBRequest;
    globalThis.IDBRequest = IDBRequest;
    globalThis.IDBTransaction = IDBTransaction;
  });

  it("includes adapterIdentity from preflight in submit requests", async () => {
    const adapter = new IndexedDbAdapter({
      dbName: createDbName(),
      endpointName: "app",
      schemas: [{ schema: appSchema }],
    });

    const commandDef: LofiSubmitCommandDefinition = {
      name: "noop",
      target: { fragment: "app", schema: "app" },
      handler: async () => undefined,
    };

    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://example.com/_internal") {
        return new Response(JSON.stringify({ adapterIdentity: "adapter-123" }), { status: 200 });
      }

      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      expect(body?.adapterIdentity).toBe("adapter-123");
      expect(body?.commands).toHaveLength(1);

      return new Response(
        JSON.stringify({
          status: "applied",
          requestId: body?.requestId ?? "req",
          confirmedCommandIds: [body?.commands?.[0]?.id],
          entries: [],
        }),
        { status: 200 },
      );
    });

    const client = new LofiSubmitClient({
      endpointName: "app",
      submitUrl: "https://example.com/_internal/sync",
      internalUrl: "https://example.com/_internal",
      adapter,
      schemas: [appSchema],
      commands: [commandDef],
      fetch: fetcher as typeof fetch,
    });

    const commandId = await client.queueCommand({
      name: "noop",
      target: { fragment: "app", schema: "app" },
      input: {},
      optimistic: false,
    });

    const response = await client.submitOnce();
    expect(response.status).toBe("applied");

    const stored = await adapter.getMeta("app::submit-queue");
    expect(stored).toBeDefined();
    const deserialized = stored ? superjson.deserialize(JSON.parse(stored)) : null;
    expect(deserialized).toEqual([]);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(commandId).toBeTruthy();
  });

  it("routes optimistic commands through the overlay store", async () => {
    const adapter = new IndexedDbAdapter({
      dbName: createDbName(),
      endpointName: "app",
      schemas: [{ schema: appSchema }],
    });

    const commandDef: LofiSubmitCommandDefinition<{ id: string; email: string }, {}> = {
      name: "createUser",
      target: { fragment: "app", schema: "app" },
      handler: async ({ input, tx }) => {
        await tx()
          .mutate(({ forSchema }) => {
            forSchema(appSchema).create("users", input);
          })
          .execute();
      },
    };

    const overlay = new LofiOverlayManager({
      endpointName: "app",
      adapter,
      schemas: [appSchema],
      commands: [commandDef as LofiSubmitCommandDefinition<unknown, {}>],
    });

    const client = new LofiSubmitClient({
      endpointName: "app",
      submitUrl: "https://example.com/_internal/sync",
      internalUrl: "https://example.com/_internal",
      adapter,
      schemas: [appSchema],
      commands: [commandDef as LofiSubmitCommandDefinition<unknown, {}>],
      overlay,
      fetch: vi.fn(async () => new Response(JSON.stringify({}), { status: 500 })) as typeof fetch,
    });

    await client.queueCommand({
      name: "createUser",
      target: { fragment: "app", schema: "app" },
      input: { id: "user-1", email: "ada@example.com" },
      optimistic: true,
    });

    const baseQuery = adapter.createQueryEngine(appSchema);
    const baseUsers = await baseQuery.find("users");
    expect(baseUsers).toHaveLength(0);

    const overlayQuery = overlay.createQueryEngine(appSchema);
    const overlayUsers = await overlayQuery.find("users");
    expect(overlayUsers).toHaveLength(1);
    expect(overlayUsers[0].email).toBe("ada@example.com");
  });
});
