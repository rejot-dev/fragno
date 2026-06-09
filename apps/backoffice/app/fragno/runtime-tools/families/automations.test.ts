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
import {
  backofficeCapabilitiesRuntimeTools,
  type BackofficeCapabilitiesRuntime,
} from "./backoffice-capabilities";

type DurableHookRecord = NonNullable<Awaited<ReturnType<DurableHooksRuntime["getHook"]>>>;

const createHook = ({
  id,
  hookName,
  payload = {
    id: `${id}-event`,
    orgId: "org-1",
    source: "telegram",
    eventType: "message.received",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: { text: "hello" },
    actor: { type: "telegram-user", externalId: "user-1" },
  },
}: {
  id: string;
  hookName: string;
  payload?: DurableHookRecord["payload"];
}): DurableHookRecord => ({
  id,
  hookName,
  status: "pending",
  attempts: 0,
  maxAttempts: 3,
  lastAttemptAt: null,
  nextRetryAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  error: null,
  payload,
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
    expect(
      backofficeCapabilitiesRuntimeTools
        .map((tool) => tool.adapters?.bash?.command)
        .filter((command) => command?.startsWith("events.catalog")),
    ).toEqual(["events.catalog.list", "events.catalog.get"]);
  });

  test("automation event catalog tools list events and get one event with JSON schemas", async () => {
    const catalogListTool = backofficeCapabilitiesRuntimeTools.find(
      (tool) => tool.id === "events.catalog.list",
    )! as (typeof backofficeCapabilitiesRuntimeTools)[9];
    const catalogGetTool = backofficeCapabilitiesRuntimeTools.find(
      (tool) => tool.id === "events.catalog.get",
    )! as (typeof backofficeCapabilitiesRuntimeTools)[10];
    const event = {
      source: "telegram",
      eventType: "message.received",
      label: "Telegram message received",
      description: "Received a Telegram message.",
      capabilityId: "telegram",
      payloadSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      actorSchema: {
        type: "object",
        properties: {
          type: { const: "external" },
          externalId: { type: "string" },
        },
        required: ["type", "externalId"],
      },
      subjectSchema: { type: "object", properties: { orgId: { type: "string" } } },
      example: { payload: { text: "hello" } },
    };
    const calls: unknown[] = [];
    const runtime: BackofficeCapabilitiesRuntime = {
      listCapabilities: async () => [],
      listHookScopes: async () => [],
      listConnections: async () => [],
      getConnection: async () => {
        throw new Error("unused");
      },
      setupConnection: async () => {
        throw new Error("unused");
      },
      getConnectionSchema: async () => {
        throw new Error("unused");
      },
      verifyConnection: async () => {
        throw new Error("unused");
      },
      resetConnection: async () => {
        throw new Error("unused");
      },
      configureConnection: async () => {
        throw new Error("unused");
      },
      listAutomationEvents: async () => {
        calls.push(["listAutomationEvents"]);
        return [
          { ...event, payloadSchema: undefined, actorSchema: undefined, subjectSchema: undefined },
        ];
      },
      getAutomationEvent: async (input) => {
        calls.push(["getAutomationEvent", input]);
        return input.source === event.source && input.type === event.eventType ? event : null;
      },
    };

    await expect(
      catalogListTool.execute({}, { runtimes: { backoffice: runtime } }),
    ).resolves.toEqual([
      {
        source: "telegram",
        eventType: "message.received",
        label: "Telegram message received",
        description: "Received a Telegram message.",
        capabilityId: "telegram",
        example: { payload: { text: "hello" } },
      },
    ]);

    const getInput = catalogGetTool.inputSchema.parse(
      catalogGetTool.adapters!.bash!.parse(["--source", "telegram", "--type", "message.received"]),
    );
    await expect(
      catalogGetTool.execute(getInput, { runtimes: { backoffice: runtime } }),
    ).resolves.toMatchObject({
      source: "telegram",
      eventType: "message.received",
      payloadSchema: { type: "object" },
      actorSchema: { type: "object" },
    });
    await expect(
      catalogGetTool.execute(
        { source: "telegram", type: "unknown.event" },
        { runtimes: { backoffice: runtime } },
      ),
    ).resolves.toBeNull();

    const formatted = catalogGetTool.adapters!.bash!.format!(event, { format: "text" });
    expect(formatted).toMatchObject({ stdout: expect.stringContaining("payload") });
    const jsonFormatted = catalogGetTool.adapters!.bash!.format!(event, { format: "json" });
    expect(jsonFormatted).toEqual({ data: event });

    expect(calls).toEqual([
      ["listAutomationEvents"],
      ["getAutomationEvent", { source: "telegram", type: "message.received" }],
      ["getAutomationEvent", { source: "telegram", type: "unknown.event" }],
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
      items: [
        {
          source: "telegram",
          eventType: "message.received",
          hookId: "event-hook",
          actor: { type: "telegram-user", externalId: "user-1" },
        },
      ],
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

  test("automation event list fails when an internal ingest hook payload is malformed", async () => {
    const [listEvents] = automationEventsRuntimeTools;
    const runtime: DurableHooksRuntime = {
      listHooks: async () => ({
        configured: true,
        hooksEnabled: true,
        namespace: "events",
        items: [
          createHook({
            id: "bad-event-hook",
            hookName: "internalIngestEvent",
            payload: { source: "telegram" },
          }),
        ],
        hasNextPage: false,
      }),
      getHook: async () => null,
    };

    await expect(listEvents.execute({}, { runtimes: { durableHooks: runtime } })).rejects.toThrow();
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
