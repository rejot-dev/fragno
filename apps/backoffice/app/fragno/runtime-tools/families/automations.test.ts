import { describe, expect, test, assert } from "vitest";

import { listAutomationEventDescriptors } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

import { createTrustedSystemBackofficeToolContext } from "../runtime-tools";
import { automationStoreRuntimeTools } from "./automations-bindings";
import { hooksRuntimeTools } from "./automations-durable-hooks";
import { automationRouterRuntimeTools } from "./automations-routing";
import {
  automationWorkflowRuntimeTools,
  type AutomationWorkflowRuntime,
} from "./automations-workflow";
import {
  automationEventsCatalogCreateTool,
  automationEventsCatalogGetTool,
  automationEventsCatalogListTool,
  type BackofficeCapabilitiesRuntime,
} from "./backoffice-capabilities";

describe("automation runtime tools", () => {
  test("derive automation bash commands from runtime tools", () => {
    expect(automationStoreRuntimeTools.map((tool) => tool.adapters?.bash?.command)).toEqual([
      "store.get",
      "store.set",
      "store.delete",
      "store.list",
    ]);
    expect(automationRouterRuntimeTools.map((tool) => tool.adapters?.bash?.command)).toEqual([
      "router.list",
      "router.get",
      "router.create",
      "router.update",
      "router.delete",
      "router.trigger-now",
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

    expect(
      [
        automationEventsCatalogListTool,
        automationEventsCatalogGetTool,
        automationEventsCatalogCreateTool,
      ].map((tool) => tool.adapters?.bash?.command),
    ).toEqual(["events.catalog.list", "events.catalog.get", "events.catalog.create"]);
  });

  test("auth organization hooks are represented in the automation event catalog", () => {
    expect(
      listAutomationEventDescriptors().filter((event) => event.source === "auth"),
    ).toMatchObject([
      {
        source: "auth",
        eventType: "organization.created",
        label: "Organization created",
        capabilityId: "auth",
        actorSchema: {
          properties: {
            scope: { const: "internal" },
            type: { const: "user" },
            id: { type: "string" },
          },
        },
        subjectSchema: {
          properties: {
            orgId: { type: "string" },
          },
        },
      },
      {
        source: "auth",
        eventType: "organization.updated",
        label: "Organization updated",
        capabilityId: "auth",
      },
    ]);
  });

  test("project, sandbox, and configured capability events are represented in the catalog", () => {
    const events = listAutomationEventDescriptors().map((event) => ({
      capabilityId: event.capabilityId,
      source: event.source,
      eventType: event.eventType,
    }));

    expect(events).toEqual(
      expect.arrayContaining([
        { capabilityId: "automations", source: "automations", eventType: "project.created" },
        { capabilityId: "automations", source: "automations", eventType: "project.updated" },
        { capabilityId: "automations", source: "automations", eventType: "project.archived" },
        { capabilityId: "sandbox", source: "sandbox", eventType: "instance.ready" },
        { capabilityId: "sandbox", source: "sandbox", eventType: "instance.stopped" },
        { capabilityId: "sandbox", source: "sandbox", eventType: "instance.failed" },
        { capabilityId: "api", source: "api", eventType: "capability.configured" },
        { capabilityId: "mcp", source: "mcp", eventType: "capability.configured" },
        { capabilityId: "resend", source: "resend", eventType: "capability.configured" },
        { capabilityId: "reson8", source: "reson8", eventType: "capability.configured" },
        { capabilityId: "upload", source: "upload", eventType: "capability.configured" },
      ]),
    );
  });

  test("automation event catalog tools list events and get one event with JSON schemas", async () => {
    const catalogListTool = automationEventsCatalogListTool;
    const catalogGetTool = automationEventsCatalogGetTool;
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
          scope: { const: "external" },
          source: { const: "telegram" },
          type: { const: "chat" },
          id: { type: "string" },
        },
        required: ["scope", "source", "type", "id"],
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
      createAutomationEvent: async () => {
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
        return input.source === event.source && input.eventType === event.eventType ? event : null;
      },
    };

    await expect(
      catalogListTool.execute(
        {},
        createTrustedSystemBackofficeToolContext({ runtimes: { backoffice: runtime } }),
      ),
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
      catalogGetTool.adapters!.bash!.parse([
        "--source",
        "telegram",
        "--event-type",
        "message.received",
      ]),
    );
    await expect(
      catalogGetTool.execute(
        getInput,
        createTrustedSystemBackofficeToolContext({ runtimes: { backoffice: runtime } }),
      ),
    ).resolves.toMatchObject({
      source: "telegram",
      eventType: "message.received",
      payloadSchema: { type: "object" },
      actorSchema: { type: "object" },
    });
    await expect(
      catalogGetTool.execute(
        { source: "telegram", eventType: "unknown.event" },
        createTrustedSystemBackofficeToolContext({ runtimes: { backoffice: runtime } }),
      ),
    ).resolves.toBeNull();

    const formatted = catalogGetTool.adapters!.bash!.format!(event, { format: "text" });
    expect(formatted).toMatchObject({ stdout: expect.stringContaining("payload") });
    const jsonFormatted = catalogGetTool.adapters!.bash!.format!(event, { format: "json" });
    expect(jsonFormatted).toEqual({ data: event });

    expect(calls).toEqual([
      ["listAutomationEvents"],
      ["getAutomationEvent", { source: "telegram", eventType: "message.received" }],
      ["getAutomationEvent", { source: "telegram", eventType: "unknown.event" }],
    ]);
  });

  test("parse and validate get input", () => {
    const [get] = automationStoreRuntimeTools;

    assert(get.name === "get");
    expect(
      get.inputSchema.parse(get.adapters!.bash!.parse(["--key", "telegram/chat-123"])),
    ).toEqual({ key: "telegram/chat-123" });
  });

  test("parse and validate set input", () => {
    const [, set] = automationStoreRuntimeTools;

    assert(set.name === "set");
    expect(
      set.inputSchema.parse(
        set.adapters!.bash!.parse([
          "--key",
          "telegram/chat-123",
          "--value",
          "user-55",
          "--actor",
          '{"scope":"external","source":"telegram","type":"chat","id":"chat-123"}',
        ]),
      ),
    ).toEqual({
      key: "telegram/chat-123",
      value: "user-55",
      actor: { scope: "external", source: "telegram", type: "chat", id: "chat-123" },
    });
  });

  test("parse and validate delete input", () => {
    const [, , deleteEntry] = automationStoreRuntimeTools;

    assert(deleteEntry.name === "delete");
    expect(
      deleteEntry.inputSchema.parse(
        deleteEntry.adapters!.bash!.parse(["--key", "telegram/chat-123"]),
      ),
    ).toEqual({ key: "telegram/chat-123" });
  });

  test("workflow retry tool parses input and calls the runtime", async () => {
    const retryTool = automationWorkflowRuntimeTools[6];
    assert(retryTool.id === "workflow.instances.retry");

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

    await expect(
      retryTool.execute(
        input,
        createTrustedSystemBackofficeToolContext({ runtimes: { workflow: runtime } }),
      ),
    ).resolves.toEqual({
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
