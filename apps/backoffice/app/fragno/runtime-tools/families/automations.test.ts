import { describe, expect, test } from "vitest";

import { automationBindingsRuntimeTools } from "./automations-bindings";
import {
  automationEventsRuntimeTools,
  hooksRuntimeTools,
  type DurableHooksRuntime,
} from "./automations-durable-hooks";
import {
  automationWorkflowRuntimeTools,
  type AutomationWorkflowRuntime,
} from "./automations-workflow";

type DurableHookRecord = NonNullable<Awaited<ReturnType<DurableHooksRuntime["getHook"]>>>;

const createHook = ({ id, hookName }: { id: string; hookName: string }): DurableHookRecord => ({
  id,
  hookName,
  status: "pending",
  attempts: 0,
  maxAttempts: 3,
  lastAttemptAt: null,
  nextRetryAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  error: null,
  payload: {},
});

describe("automation runtime tools", () => {
  test("derive automation bash commands from runtime tools", () => {
    expect(automationBindingsRuntimeTools.map((tool) => tool.adapters?.bash?.command)).toEqual([
      "identity.lookup-binding",
      "identity.bind-actor",
    ]);
    expect(automationWorkflowRuntimeTools.map((tool) => tool.adapters?.bash?.command)).toEqual([
      "workflow.list",
      "workflow.instances.create",
      "workflow.instances.list",
      "workflow.instances.get",
      "workflow.instances.history",
      "workflow.instances.send-event",
      "workflow.instances.retry",
    ]);
    expect(hooksRuntimeTools.map((tool) => tool.adapters?.bash?.command)).toEqual([
      "hooks.list",
      "hooks.get",
    ]);
    expect(automationEventsRuntimeTools.map((tool) => tool.adapters?.bash?.command)).toEqual([
      "events.list",
      "events.get",
    ]);
  });

  test("automation event tools only read automations internalIngestEvent hooks", async () => {
    const [listEvents, getEvent] = automationEventsRuntimeTools;
    const calls: unknown[] = [];
    const runtime: DurableHooksRuntime = {
      listHooks: async (input) => {
        calls.push(["listHooks", input]);
        return {
          configured: true,
          hooksEnabled: true,
          namespace: "events",
          items: [
            createHook({ id: "event-hook", hookName: "internalIngestEvent" }),
            createHook({ id: "other-hook", hookName: "sendTelegramMessage" }),
          ],
          hasNextPage: false,
        };
      },
      getHook: async (input) => {
        calls.push(["getHook", input]);
        return createHook({
          id: input.hookId,
          hookName: input.hookId === "event-hook" ? "internalIngestEvent" : "sendTelegramMessage",
        });
      },
    };

    await expect(
      listEvents.execute({ pageSize: 20 }, { runtimes: { durableHooks: runtime } }),
    ).resolves.toMatchObject({
      items: [{ id: "event-hook", hookName: "internalIngestEvent" }],
    });
    await expect(
      getEvent.execute({ hookId: "event-hook" }, { runtimes: { durableHooks: runtime } }),
    ).resolves.toMatchObject({ id: "event-hook", hookName: "internalIngestEvent" });
    await expect(
      getEvent.execute({ hookId: "other-hook" }, { runtimes: { durableHooks: runtime } }),
    ).resolves.toBeNull();

    expect(calls).toEqual([
      ["listHooks", { fragment: "automations", pageSize: 20 }],
      ["getHook", { fragment: "automations", hookId: "event-hook" }],
      ["getHook", { fragment: "automations", hookId: "other-hook" }],
    ]);
  });

  test("parse and validate lookupBinding input", () => {
    const [lookupBinding] = automationBindingsRuntimeTools;

    expect(lookupBinding.name).toBe("lookupBinding");
    expect(
      lookupBinding.inputSchema.parse(
        lookupBinding.adapters!.bash!.parse(["--source", "telegram", "--key", "chat-123"]),
      ),
    ).toEqual({ source: "telegram", key: "chat-123" });
  });

  test("parse and validate bindActor input", () => {
    const [, bindActor] = automationBindingsRuntimeTools;

    expect(bindActor.name).toBe("bindActor");
    expect(
      bindActor.inputSchema.parse(
        bindActor.adapters!.bash!.parse([
          "--source",
          "telegram",
          "--key",
          "chat-123",
          "--value",
          "user-55",
          "--description",
          "Primary device",
        ]),
      ),
    ).toEqual({
      source: "telegram",
      key: "chat-123",
      value: "user-55",
      description: "Primary device",
    });
  });

  test("workflow retry tool parses input and calls the runtime", async () => {
    const retryTool = automationWorkflowRuntimeTools[6];
    expect(retryTool.id).toBe("workflow.instances.retry");

    const calls: unknown[] = [];
    const runtime: AutomationWorkflowRuntime = {
      createInstance: async ({ workflowName, instanceId }) => ({
        workflowName,
        instanceId: instanceId ?? "generated",
      }),
      getStatus: async () => ({ status: "waiting" }),
      sendEvent: async () => null,
      retryInstance: async (input) => {
        calls.push(input);
        return {
          accepted: true,
          instance: { id: input.instanceId, details: { status: "waiting" } },
          retry: {
            stepKey: input.stepKey ?? "do:latest",
            attempts: 1,
            maxAttempts: 2,
            scheduledAt: "2026-01-01T00:00:00.000Z",
          },
        };
      },
    };

    const input = retryTool.inputSchema.parse(
      retryTool.adapters!.bash!.parse([
        "--workflow-name",
        "demo-workflow",
        "--instance-id",
        "run-1",
        "--step-key",
        "do:flaky",
        "--delay-ms",
        "250",
        "--reason",
        "manual retry",
      ]),
    );

    await expect(retryTool.execute(input, { runtimes: { workflow: runtime } })).resolves.toEqual({
      accepted: true,
      instance: { id: "run-1", details: { status: "waiting" } },
      retry: {
        stepKey: "do:flaky",
        attempts: 1,
        maxAttempts: 2,
        scheduledAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(calls).toEqual([
      {
        workflowName: "demo-workflow",
        instanceId: "run-1",
        stepKey: "do:flaky",
        delayMs: 250,
        reason: "manual retry",
      },
    ]);
  });
});
