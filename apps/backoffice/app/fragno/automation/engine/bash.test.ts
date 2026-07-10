import { describe, expect, it, assert } from "vitest";

import { createUnsupportedOperationFileSystemError } from "@/files/fs-errors";
import { createUnsupportedFileSystem } from "@/files/interface";
import { MasterFileSystem } from "@/files/master-file-system";
import { executeBashAutomation } from "@/fragno/runtime-tools/automation-host";
import { createUnavailableAutomationRouterRuntime } from "@/fragno/runtime-tools/families/automations-routing";

import { AUTOMATION_SYSTEM_ACTOR, type AutomationEvent } from "../contracts";
import {
  createAutomationExecutionContext as createRuntimeAutomationExecutionContext,
  createAutomationRuntime as createRouteBackedAutomationRuntime,
  type AutomationRuntime,
} from "./runtime";

const runtime: AutomationRuntime = {
  ...createUnavailableAutomationRouterRuntime(),
  get: async () => null,
  set: async (input) => ({
    key: input.key,
    value: input.value,
    category: input.category ?? [],
    actor: input.actor,
  }),
  delete: async (input) => ({ ok: true, key: input.key }),
  list: async () => [],
  createClaim: async (input) => ({
    url: `https://example.com/${input.actor.id}`,
    otpId: "otp-123",
    externalId: input.actor.id,
    code: "123456",
    actor: input.actor,
  }),
  emitEvent: async (input) => ({
    accepted: true,
    eventId: "emitted-1",
    scope: input.targetScope ?? { kind: "org", orgId: "org-1" },
    source: input.source ?? "otp",
    eventType: input.eventType,
  }),
};

const createAutomationRuntime = (
  overrides: Partial<AutomationRuntime> = {},
): AutomationRuntime => ({
  ...runtime,
  ...overrides,
});

const createTestEvent = (
  event: Omit<AutomationEvent, "actor" | "actors" | "scope"> &
    Partial<Pick<AutomationEvent, "actor" | "actors" | "scope">>,
): AutomationEvent => {
  const actor = event.actor ?? AUTOMATION_SYSTEM_ACTOR;
  return {
    ...event,
    scope: event.scope ?? { kind: "org", orgId: "org-1" },
    actor,
    actors: event.actors ?? [actor],
  };
};

const createDeferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
};

const createTestAutomationExecutionContext = ({
  event,
  runtime: automationRuntime,
}: {
  event: AutomationEvent;
  runtime: AutomationRuntime;
}) =>
  createRuntimeAutomationExecutionContext({
    event,
    binding: {
      source: event.source,
      eventType: event.eventType,
      scriptId: `script-${event.id}`,
    },
    idempotencyKey: `idempotency-${event.id}`,
    runtime: automationRuntime,
    pi: null,
  });

describe("bash command runner", () => {
  it("provides /context/event.json for automation runs", async () => {
    const event: AutomationEvent = {
      id: "event-123",
      scope: { kind: "org", orgId: "org-1" },
      source: "telegram",
      eventType: "message.received",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: {
        messageId: "message-1",
        chatId: "chat-1",
        fromUserId: "from-1",
        text: "/start",
      },
      actor: {
        scope: "external",
        source: "telegram",
        type: "chat",
        id: "chat-1",
      },
      actors: [{ scope: "external", source: "telegram", type: "chat", id: "chat-1" }],
      subject: {
        userId: "user-1",
      },
    };

    const automationRuntime = createRouteBackedAutomationRuntime({
      event,
    });
    const result = await executeBashAutomation({
      script: 'printf "event=%s\\n" "$(cat /context/event.json)"',
      masterFs: new MasterFileSystem({
        mounts: [],
      }),
      context: createRuntimeAutomationExecutionContext({
        event,
        binding: {
          source: "telegram",
          eventType: "message.received",
          scriptId: "script-1",
        },
        idempotencyKey: "idempotency-1",
        runtime: automationRuntime,
        pi: null,
      }),
    });

    assert(result.exitCode === 0);
    assert(
      result.stdout.trim() ===
        'event={"id":"event-123","scope":{"kind":"org","orgId":"org-1"},"source":"telegram","eventType":"message.received","occurredAt":"2026-01-01T00:00:00.000Z","payload":{"messageId":"message-1","chatId":"chat-1","fromUserId":"from-1","text":"/start"},"actor":{"scope":"external","source":"telegram","type":"chat","id":"chat-1"},"actors":[{"scope":"external","source":"telegram","type":"chat","id":"chat-1"}],"subject":{"userId":"user-1"}}',
    );
  });

  it("mounts /dev/null so scripts can discard output", async () => {
    const event = createTestEvent({
      id: "dev-null-event",
      source: "telegram",
      eventType: "message.received",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: {},
    });
    const automationRuntime = createRouteBackedAutomationRuntime({
      event,
    });

    const result = await executeBashAutomation({
      script: 'echo "discarded" >/dev/null && echo "kept"',
      masterFs: new MasterFileSystem({
        mounts: [],
      }),
      context: createRuntimeAutomationExecutionContext({
        event,
        binding: { source: "telegram", eventType: "message.received", scriptId: "s-dev" },
        idempotencyKey: "idem-dev",
        runtime: automationRuntime,
        pi: null,
      }),
    });

    assert(result.exitCode === 0);
    assert(result.stdout.trim() === "kept");
  });

  it("keeps the shared master filesystem mount list unchanged after execution", async () => {
    const masterFs = new MasterFileSystem({
      mounts: [],
    });
    const event = createTestEvent({
      id: "cleanup-event",
      source: "telegram",
      eventType: "message.received",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: {},
    });

    const automationRuntime = createRouteBackedAutomationRuntime({
      event,
    });

    await executeBashAutomation({
      script: "echo ok",
      masterFs,
      context: createRuntimeAutomationExecutionContext({
        event,
        binding: { source: "telegram", eventType: "message.received", scriptId: "s-cleanup" },
        idempotencyKey: "idem-cleanup",
        runtime: automationRuntime,
        pi: null,
      }),
    });

    expect(masterFs.mounts).toHaveLength(0);
  });

  it("isolates /context/event.json across overlapping executions", async () => {
    const masterFs = new MasterFileSystem({
      mounts: [],
    });
    const releaseFirstRun = createDeferred();
    const firstRunBlocked = createDeferred();

    const firstEvent: AutomationEvent = createTestEvent({
      id: "event-overlap-a",
      scope: { kind: "org", orgId: "org-1" },
      source: "telegram",
      eventType: "message.received",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: { run: "a" },
    });
    const secondEvent: AutomationEvent = createTestEvent({
      id: "event-overlap-b",
      scope: { kind: "org", orgId: "org-1" },
      source: "telegram",
      eventType: "message.received",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: { run: "b" },
    });

    const firstRun = executeBashAutomation({
      script:
        'events.fire --event-type overlap.wait --source test >/dev/null\nprintf "run-a=%s\\n" "$(cat /context/event.json)"',
      masterFs,
      context: createTestAutomationExecutionContext({
        event: firstEvent,
        runtime: createAutomationRuntime({
          emitEvent: async (input) => {
            firstRunBlocked.resolve();
            await releaseFirstRun.promise;
            return {
              accepted: true,
              eventId: `emitted:${input.eventType}`,
              scope: { kind: "org", orgId: "org-1" },
              source: input.source ?? "test",
              eventType: input.eventType,
            };
          },
        }),
      }),
    });

    await firstRunBlocked.promise;

    const secondRun = await executeBashAutomation({
      script:
        'printf "before=%s\\n" "$(cat /context/event.json)"\n' +
        "events.fire --event-type overlap.read --source test >/dev/null\n" +
        'printf "after=%s\\n" "$(cat /context/event.json)"',
      masterFs,
      context: createTestAutomationExecutionContext({
        event: secondEvent,
        runtime: createAutomationRuntime(),
      }),
    });

    releaseFirstRun.resolve();
    const completedFirstRun = await firstRun;

    assert(completedFirstRun.exitCode === 0);
    assert(secondRun.exitCode === 0);
    expect(secondRun.stdout).toContain('before={"id":"event-overlap-b"');
    expect(secondRun.stdout).toContain('after={"id":"event-overlap-b"');
    expect(secondRun.stdout).not.toContain('"id":"event-overlap-a"');
  });

  it("keeps /context and /dev available when another overlapping execution finishes", async () => {
    const masterFs = new MasterFileSystem({
      mounts: [],
    });
    const releaseFirstRun = createDeferred();
    const firstRunBlocked = createDeferred();
    const releaseSecondRun = createDeferred();
    const secondRunBlocked = createDeferred();

    const firstEvent: AutomationEvent = createTestEvent({
      id: "event-cleanup-a",
      scope: { kind: "org", orgId: "org-1" },
      source: "telegram",
      eventType: "message.received",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: { run: "a" },
    });
    const secondEvent: AutomationEvent = createTestEvent({
      id: "event-cleanup-b",
      scope: { kind: "org", orgId: "org-1" },
      source: "telegram",
      eventType: "message.received",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: { run: "b" },
    });

    const firstRun = executeBashAutomation({
      script:
        "events.fire --event-type cleanup.wait-a --source test >/dev/null\necho first-run-complete",
      masterFs,
      context: createTestAutomationExecutionContext({
        event: firstEvent,
        runtime: createAutomationRuntime({
          emitEvent: async (input) => {
            firstRunBlocked.resolve();
            await releaseFirstRun.promise;
            return {
              accepted: true,
              eventId: `emitted:${input.eventType}`,
              scope: { kind: "org", orgId: "org-1" },
              source: input.source ?? "test",
              eventType: input.eventType,
            };
          },
        }),
      }),
    });

    await firstRunBlocked.promise;

    const secondRunPromise = executeBashAutomation({
      script:
        'printf "before=%s\\n" "$(cat /context/event.json)"\n' +
        "events.fire --event-type cleanup.wait-b --source test >/dev/null\n" +
        "cat /context/event.json >/dev/null\n" +
        "echo kept >/dev/null\n" +
        'printf "after=%s\\n" "$(cat /context/event.json)"',
      masterFs,
      context: createTestAutomationExecutionContext({
        event: secondEvent,
        runtime: createAutomationRuntime({
          emitEvent: async (input) => {
            secondRunBlocked.resolve();
            await releaseSecondRun.promise;
            return {
              accepted: true,
              eventId: `emitted:${input.eventType}`,
              scope: { kind: "org", orgId: "org-1" },
              source: input.source ?? "test",
              eventType: input.eventType,
            };
          },
        }),
      }),
    });

    await secondRunBlocked.promise;

    releaseFirstRun.resolve();
    const completedFirstRun = await firstRun;
    assert(completedFirstRun.exitCode === 0);

    releaseSecondRun.resolve();
    const secondRun = await secondRunPromise;

    assert(secondRun.exitCode === 0);
    assert(secondRun.stderr === "");
    expect(secondRun.stdout).toContain('before={"id":"event-cleanup-b"');
    expect(secondRun.stdout).toContain('after={"id":"event-cleanup-b"');
  });

  it("skips /dev mount when one already exists on the master filesystem", async () => {
    const masterFs = new MasterFileSystem({
      mounts: [],
    });
    masterFs.mount({
      id: "existing-dev",
      kind: "custom",
      mountPoint: "/dev",
      title: "Existing /dev",
      readOnly: false,
      persistence: "session",
      fs: createUnsupportedFileSystem(createUnsupportedOperationFileSystemError, {
        readFile: async () => "",
        readdir: async () => [],
        getAllPaths: () => ["/dev"],
      }),
    });

    const event = createTestEvent({
      id: "existing-dev-event",
      source: "telegram",
      eventType: "message.received",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: {},
    });
    const automationRuntime = createRouteBackedAutomationRuntime({
      event,
    });

    await executeBashAutomation({
      script: "echo ok",
      masterFs,
      context: createRuntimeAutomationExecutionContext({
        event,
        binding: { source: "telegram", eventType: "message.received", scriptId: "s-edev" },
        idempotencyKey: "idem-edev",
        runtime: automationRuntime,
        pi: null,
      }),
    });

    expect(masterFs.mounts).toHaveLength(1);
    assert(masterFs.mounts[0]!.id === "existing-dev");
  });
});
