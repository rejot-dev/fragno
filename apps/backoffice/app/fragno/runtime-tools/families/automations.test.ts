import { describe, expect, test } from "vitest";

import { automationBindingsRuntimeTools } from "./automations-bindings";
import {
  automationEventsRuntimeTools,
  hooksRuntimeTools,
  type DurableHooksRuntime,
} from "./automations-durable-hooks";
import { automationWorkflowRuntimeTools } from "./automations-workflow";

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
      "automations.identity.lookup-binding",
      "automations.identity.bind-actor",
    ]);
    expect(automationWorkflowRuntimeTools.map((tool) => tool.adapters?.bash?.command)).toEqual([
      "workflow.create-instance",
      "workflow.get-status",
      "workflow.send-event",
      "workflow.list",
      "workflow.instances.list",
      "workflow.instances.get",
      "workflow.instances.history",
    ]);
    expect(hooksRuntimeTools.map((tool) => tool.adapters?.bash?.command)).toEqual([
      "hooks.list",
      "hooks.get",
    ]);
    expect(automationEventsRuntimeTools.map((tool) => tool.adapters?.bash?.command)).toEqual([
      "automations.events.list",
      "automations.events.get",
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
          namespace: "automation",
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
});
