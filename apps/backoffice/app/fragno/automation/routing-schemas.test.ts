import { describe, expect, test } from "vitest";

import { zodSchemaToTypeScriptRender } from "@/lib/zod/zod-formatter";

import { automationRouteActionSchema, automationRouteCreateInputSchema } from "./routing-schemas";

describe("automation routing schemas", () => {
  test("send_workflow_event actions target an instance id directly or through the store", () => {
    expect(
      automationRouteActionSchema.parse({
        kind: "send_workflow_event",
        target: { kind: "instance_id", template: "route/${event.id}" },
        eventType: "message.received",
      }),
    ).toMatchObject({
      kind: "send_workflow_event",
      workflowName: "automation-codemode-script",
      target: { kind: "instance_id", template: "route/${event.id}" },
      eventType: "message.received",
    });

    expect(
      automationRouteActionSchema.parse({
        kind: "send_workflow_event",
        target: { kind: "stored_instance_id", keyTemplate: "route/${event.payload.threadId}" },
        eventType: "reply.received",
      }),
    ).toMatchObject({
      kind: "send_workflow_event",
      workflowName: "automation-codemode-script",
      target: { kind: "stored_instance_id", keyTemplate: "route/${event.payload.threadId}" },
      eventType: "reply.received",
    });

    expect(() =>
      automationRouteActionSchema.parse({
        kind: "send_workflow_event",
        eventType: "reply.received",
      }),
    ).toThrow();
    expect(() =>
      automationRouteActionSchema.parse({
        kind: "send_workflow_event",
        target: { kind: "stored_instance_id", keyTemplate: "" },
        eventType: "reply.received",
      }),
    ).toThrow();
  });

  test("renders send_workflow_event action inputs with explicit target shapes", () => {
    expect(
      zodSchemaToTypeScriptRender(automationRouteCreateInputSchema, "input", {
        rootTypeName: "RouterCreateInput",
      }).declarations.find((declaration) =>
        declaration.startsWith("type AutomationSendWorkflowEventActionInput ="),
      ),
    ).toMatchInlineSnapshot(`
      "type AutomationSendWorkflowEventActionInput = {
        kind: "send_workflow_event";
        workflowName?: string;
        target: AutomationWorkflowEventTarget;
        eventType: string;
        payload?: unknown;
      };"
    `);
  });

  test("renders workflow event target as a named union", () => {
    expect(
      zodSchemaToTypeScriptRender(automationRouteCreateInputSchema, "input", {
        rootTypeName: "RouterCreateInput",
      }).declarations.filter((declaration) =>
        declaration.startsWith("type AutomationWorkflowEvent"),
      ),
    ).toMatchInlineSnapshot(`
      [
        "type AutomationWorkflowEventTarget = AutomationWorkflowEventInstanceIdTarget | AutomationWorkflowEventStoredInstanceIdTarget;",
        "type AutomationWorkflowEventInstanceIdTarget = {
        kind: "instance_id";
        template: string;
      };",
        "type AutomationWorkflowEventStoredInstanceIdTarget = {
        kind: "stored_instance_id";
        keyTemplate: string;
      };",
      ]
    `);
  });
});
