import { describe, expect, it } from "vitest";

import { InMemoryFs } from "just-bash";

import { MasterFileSystem } from "@/files/master-file-system";
import { normalizeMountedFileSystem } from "@/files/mounted-file-system";
import { createBashHost, executeBashAutomation } from "@/fragno/runtime-tools/bash-host";

import type { AutomationEvent } from "../contracts";
import {
  createAutomationExecutionContext as createRuntimeAutomationExecutionContext,
  createAutomationRuntime as createStorageBackedAutomationRuntime,
  type AutomationRuntime,
} from "./runtime";

const runtime: AutomationRuntime = {
  lookupBinding: async () => null,
  bindActor: async (input) => ({
    source: input.source,
    key: input.key,
    value: input.value,
    status: "linked",
  }),
  createClaim: async (input) => ({
    url: `https://example.com/${input.externalActorId}`,
    externalId: input.externalActorId,
    code: "123456",
  }),
  emitEvent: async (input) => ({
    accepted: true,
    eventId: "emitted-1",
    orgId: undefined,
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
  it("forwards sub-script stdout through scripts.run", async () => {
    const { bash, commandCallsResult } = createBashHost({
      fs: new InMemoryFs(),
      context: {
        automation: null,
        automations: {
          runtime: {
            lookupBinding: runtime.lookupBinding,
            bindActor: runtime.bindActor,
          },
          scriptRunner: {
            runScript: async (args) => {
              expect(args).toEqual({
                script: "/automations/test.sh",
                event: "/events/2026-03-26/evt-1.json",
              });
              return {
                runtime: "bash",
                eventId: "evt-1",
                scriptId: "manual:/automations/test.sh",
                exitCode: 0,
                stdout: "hello from sub-script\n",
                stderr: "",
                logs: [],
                commandCalls: [],
                toolCalls: [],
              };
            },
          },
        },
        otp: null,
        pi: null,
        reson8: null,
        resend: null,
        telegram: null,
      },
    });

    const result = await bash.exec(
      "scripts.run --script /automations/test.sh --event /events/2026-03-26/evt-1.json",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello from sub-script");
    expect(commandCallsResult).toEqual([
      {
        command: "scripts.run",
        output: "hello from sub-script",
        exitCode: 0,
      },
    ]);
  });

  it("returns structured data with --format json for scripts.run", async () => {
    const { bash } = createBashHost({
      fs: new InMemoryFs(),
      context: {
        automation: null,
        automations: {
          runtime: {
            lookupBinding: runtime.lookupBinding,
            bindActor: runtime.bindActor,
          },
          scriptRunner: {
            runScript: async () => ({
              runtime: "bash",
              eventId: "evt-1",
              scriptId: "manual:/automations/test.sh",
              exitCode: 0,
              stdout: "echoed output\n",
              stderr: "",
              logs: [],
              commandCalls: [{ command: "event.emit", output: "", exitCode: 0 }],
              toolCalls: [],
            }),
          },
        },
        otp: null,
        pi: null,
        reson8: null,
        resend: null,
        telegram: null,
      },
    });

    const result = await bash.exec(
      "scripts.run --script /automations/test.sh --event /events/2026-03-26/evt-1.json --format json",
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout!.trim());
    expect(parsed).toEqual({
      runtime: "bash",
      exitCode: 0,
      stdout: "echoed output\n",
      stderr: "",
      logs: [],
      commandCalls: [{ command: "event.emit", output: "", exitCode: 0 }],
      toolCalls: [],
    });
  });

  it("forwards stderr and exit code for failed sub-scripts", async () => {
    const { bash } = createBashHost({
      fs: new InMemoryFs(),
      context: {
        automation: null,
        automations: {
          runtime: {
            lookupBinding: runtime.lookupBinding,
            bindActor: runtime.bindActor,
          },
          scriptRunner: {
            runScript: async () => ({
              runtime: "bash",
              eventId: "evt-1",
              scriptId: "manual:/automations/fail.sh",
              exitCode: 1,
              stdout: "partial output\n",
              stderr: "something went wrong\n",
              logs: [],
              commandCalls: [],
              toolCalls: [],
            }),
          },
        },
        otp: null,
        pi: null,
        reson8: null,
        resend: null,
        telegram: null,
      },
    });

    const result = await bash.exec(
      "scripts.run --script /automations/fail.sh --event /events/2026-03-26/evt-1.json",
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("partial output");
    expect(result.stderr).toContain("something went wrong");
  });

  it("provides /context/event.json for automation runs", async () => {
    const event: AutomationEvent = {
      id: "event-123",
      orgId: "org-1",
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
        type: "external",
        externalId: "chat-1",
      },
      subject: {
        userId: "user-1",
      },
    };

    const automationRuntime = createStorageBackedAutomationRuntime({
      hookContext: {
        handlerTx: (() => {
          throw new Error("handlerTx should not be used in this test");
        }) as never,
      },
      event,
    });
    const result = await executeBashAutomation({
      script: 'printf "event=%s\\n" "$(cat /context/event.json)"',
      masterFs: new MasterFileSystem({ mounts: [] }),
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

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      'event={"id":"event-123","orgId":"org-1","source":"telegram","eventType":"message.received","occurredAt":"2026-01-01T00:00:00.000Z","payload":{"messageId":"message-1","chatId":"chat-1","fromUserId":"from-1","text":"/start"},"actor":{"type":"external","externalId":"chat-1"},"subject":{"userId":"user-1"}}',
    );
  });

  it("mounts /dev/null so scripts can discard output", async () => {
    const automationRuntime = createStorageBackedAutomationRuntime({
      hookContext: {
        handlerTx: (() => {
          throw new Error("handlerTx should not be used in this test");
        }) as never,
      },
      event: {
        id: "dev-null-event",
        source: "telegram",
        eventType: "message.received",
        occurredAt: "2026-01-01T00:00:00.000Z",
        payload: {},
      },
    });

    const result = await executeBashAutomation({
      script: 'echo "discarded" >/dev/null && echo "kept"',
      masterFs: new MasterFileSystem({ mounts: [] }),
      context: createRuntimeAutomationExecutionContext({
        event: {
          id: "dev-null-event",
          source: "telegram",
          eventType: "message.received",
          occurredAt: "2026-01-01T00:00:00.000Z",
          payload: {},
        },
        binding: { source: "telegram", eventType: "message.received", scriptId: "s-dev" },
        idempotencyKey: "idem-dev",
        runtime: automationRuntime,
        pi: null,
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("kept");
  });

  it("keeps the shared master filesystem mount list unchanged after execution", async () => {
    const masterFs = new MasterFileSystem({ mounts: [] });

    const automationRuntime = createStorageBackedAutomationRuntime({
      hookContext: {
        handlerTx: (() => {
          throw new Error("handlerTx should not be used in this test");
        }) as never,
      },
      event: {
        id: "cleanup-event",
        source: "telegram",
        eventType: "message.received",
        occurredAt: "2026-01-01T00:00:00.000Z",
        payload: {},
      },
    });

    await executeBashAutomation({
      script: "echo ok",
      masterFs,
      context: createRuntimeAutomationExecutionContext({
        event: {
          id: "cleanup-event",
          source: "telegram",
          eventType: "message.received",
          occurredAt: "2026-01-01T00:00:00.000Z",
          payload: {},
        },
        binding: { source: "telegram", eventType: "message.received", scriptId: "s-cleanup" },
        idempotencyKey: "idem-cleanup",
        runtime: automationRuntime,
        pi: null,
      }),
    });

    expect(masterFs.mounts).toHaveLength(0);
  });

  it("isolates /context/event.json across overlapping executions", async () => {
    const masterFs = new MasterFileSystem({ mounts: [] });
    const releaseFirstRun = createDeferred();
    const firstRunBlocked = createDeferred();

    const firstEvent: AutomationEvent = {
      id: "event-overlap-a",
      orgId: "org-1",
      source: "telegram",
      eventType: "message.received",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: { run: "a" },
    };
    const secondEvent: AutomationEvent = {
      id: "event-overlap-b",
      orgId: "org-1",
      source: "telegram",
      eventType: "message.received",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: { run: "b" },
    };

    const firstRun = executeBashAutomation({
      script:
        'event.emit --event-type overlap.wait --source test >/dev/null\nprintf "run-a=%s\\n" "$(cat /context/event.json)"',
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
              orgId: "org-1",
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
        "event.emit --event-type overlap.read --source test >/dev/null\n" +
        'printf "after=%s\\n" "$(cat /context/event.json)"',
      masterFs,
      context: createTestAutomationExecutionContext({
        event: secondEvent,
        runtime: createAutomationRuntime(),
      }),
    });

    releaseFirstRun.resolve();
    const completedFirstRun = await firstRun;

    expect(completedFirstRun.exitCode).toBe(0);
    expect(secondRun.exitCode).toBe(0);
    expect(secondRun.stdout).toContain('before={"id":"event-overlap-b"');
    expect(secondRun.stdout).toContain('after={"id":"event-overlap-b"');
    expect(secondRun.stdout).not.toContain('"id":"event-overlap-a"');
  });

  it("keeps /context and /dev available when another overlapping execution finishes", async () => {
    const masterFs = new MasterFileSystem({ mounts: [] });
    const releaseFirstRun = createDeferred();
    const firstRunBlocked = createDeferred();
    const releaseSecondRun = createDeferred();
    const secondRunBlocked = createDeferred();

    const firstEvent: AutomationEvent = {
      id: "event-cleanup-a",
      orgId: "org-1",
      source: "telegram",
      eventType: "message.received",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: { run: "a" },
    };
    const secondEvent: AutomationEvent = {
      id: "event-cleanup-b",
      orgId: "org-1",
      source: "telegram",
      eventType: "message.received",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: { run: "b" },
    };

    const firstRun = executeBashAutomation({
      script:
        "event.emit --event-type cleanup.wait-a --source test >/dev/null\necho first-run-complete",
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
              orgId: "org-1",
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
        "event.emit --event-type cleanup.wait-b --source test >/dev/null\n" +
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
              orgId: "org-1",
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
    expect(completedFirstRun.exitCode).toBe(0);

    releaseSecondRun.resolve();
    const secondRun = await secondRunPromise;

    expect(secondRun.exitCode).toBe(0);
    expect(secondRun.stderr).toBe("");
    expect(secondRun.stdout).toContain('before={"id":"event-cleanup-b"');
    expect(secondRun.stdout).toContain('after={"id":"event-cleanup-b"');
  });

  it("skips /dev mount when one already exists on the master filesystem", async () => {
    const masterFs = new MasterFileSystem({ mounts: [] });
    masterFs.mount({
      id: "existing-dev",
      kind: "custom",
      mountPoint: "/dev",
      title: "Existing /dev",
      readOnly: false,
      persistence: "session",
      fs: normalizeMountedFileSystem(
        {
          readFile: async () => "",
          readdir: async () => [],
          getAllPaths: () => ["/dev"],
        },
        { readOnly: false },
      ),
    });

    const automationRuntime = createStorageBackedAutomationRuntime({
      hookContext: {
        handlerTx: (() => {
          throw new Error("handlerTx should not be used in this test");
        }) as never,
      },
      event: {
        id: "existing-dev-event",
        source: "telegram",
        eventType: "message.received",
        occurredAt: "2026-01-01T00:00:00.000Z",
        payload: {},
      },
    });

    await executeBashAutomation({
      script: "echo ok",
      masterFs,
      context: createRuntimeAutomationExecutionContext({
        event: {
          id: "existing-dev-event",
          source: "telegram",
          eventType: "message.received",
          occurredAt: "2026-01-01T00:00:00.000Z",
          payload: {},
        },
        binding: { source: "telegram", eventType: "message.received", scriptId: "s-edev" },
        idempotencyKey: "idem-edev",
        runtime: automationRuntime,
        pi: null,
      }),
    });

    expect(masterFs.mounts).toHaveLength(1);
    expect(masterFs.mounts[0]!.id).toBe("existing-dev");
  });
});
