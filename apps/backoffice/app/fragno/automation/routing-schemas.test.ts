import { describe, expect, test } from "vitest";

import { zodSchemaToTypeScriptRender } from "@/lib/zod/zod-formatter";

import { automationRouteActionSchema, automationRouteCreateInputSchema } from "./routing-schemas";

describe("automation routing schemas", () => {
  test("start_workflow actions discard caller-supplied workflow hosts", () => {
    const action = automationRouteActionSchema.parse({
      kind: "start_workflow",
      workflowName: "wrong-workflow-host",
      remoteWorkflowName: "daily-digest",
      workflowScriptPath: "/workspace/automations/daily-digest.workflow.js",
      instanceIdTemplate: "daily-digest-${event.id}",
    });

    expect(action).toEqual({
      kind: "start_workflow",
      remoteWorkflowName: "daily-digest",
      workflowScriptPath: "/workspace/automations/daily-digest.workflow.js",
      instanceIdTemplate: "daily-digest-${event.id}",
    });
    expect(action).not.toHaveProperty("workflowName");
  });

  test("renders start_workflow action inputs without a configurable workflow host", () => {
    const declaration = zodSchemaToTypeScriptRender(automationRouteCreateInputSchema, "input", {
      rootTypeName: "RouterCreateInput",
    }).declarations.find((candidate) =>
      candidate.startsWith("type AutomationStartWorkflowActionInput ="),
    );

    expect(declaration).toBe(
      [
        "type AutomationStartWorkflowActionInput = {",
        '  kind: "start_workflow";',
        "  remoteWorkflowName?: string;",
        "  workflowScriptPath: string;",
        "  instanceIdTemplate: string;",
        "};",
      ].join("\n"),
    );
  });

  test("accepts structural actor matchers and rejects invalid delegation roles", () => {
    expect(
      automationRouteCreateInputSchema.parse({
        id: "telegram-route",
        name: "Telegram route",
        trigger: {
          kind: "event",
          source: "telegram",
          eventType: "message.received",
          matcher: {
            actor: {
              participation: "initiator",
              scope: "external",
              source: "telegram",
              type: "chat",
            },
          },
        },
        action: {
          kind: "start_workflow",
          workflowScriptPath: "/workspace/automations/telegram.workflow.js",
          instanceIdTemplate: "telegram-${event.id}",
        },
      }).trigger,
    ).toMatchObject({
      matcher: {
        actor: {
          participation: "initiator",
          scope: "external",
          source: "telegram",
          type: "chat",
        },
      },
    });

    expect(() =>
      automationRouteCreateInputSchema.parse({
        id: "invalid-internal-actor-source",
        name: "Invalid internal actor source",
        trigger: {
          kind: "event",
          source: "telegram",
          eventType: "message.received",
          matcher: {
            actor: {
              participation: "initiator",
              scope: "internal",
              source: "telegram",
            },
          },
        },
        action: {
          kind: "start_workflow",
          workflowScriptPath: "/workspace/automations/telegram.workflow.js",
          instanceIdTemplate: "telegram-${event.id}",
        },
      }),
    ).toThrow();

    expect(() =>
      automationRouteCreateInputSchema.parse({
        id: "invalid-actor-path",
        name: "Invalid actor path",
        trigger: {
          kind: "event",
          source: "telegram",
          eventType: "message.received",
          matcher: { path: "$.actors.initiator.source", op: "eq", value: "telegram" },
        },
        action: {
          kind: "start_workflow",
          workflowScriptPath: "/workspace/automations/telegram.workflow.js",
          instanceIdTemplate: "telegram-${event.id}",
        },
      }),
    ).toThrow("Actor routing must use the structural actor matcher");

    expect(() =>
      automationRouteCreateInputSchema.parse({
        id: "invalid-legacy-actor-path",
        name: "Invalid legacy actor path",
        trigger: {
          kind: "event",
          source: "telegram",
          eventType: "message.received",
          matcher: { path: "$.actor.source", op: "eq", value: "telegram" },
        },
        action: {
          kind: "start_workflow",
          workflowScriptPath: "/workspace/automations/telegram.workflow.js",
          instanceIdTemplate: "telegram-${event.id}",
        },
      }),
    ).toThrow("Actor routing must use the structural actor matcher");

    expect(() =>
      automationRouteCreateInputSchema.parse({
        id: "invalid-principal-delegation",
        name: "Invalid principal delegation",
        trigger: {
          kind: "event",
          source: "telegram",
          eventType: "message.received",
          matcher: {
            actor: {
              participation: "delegation",
              scope: "internal",
              role: "principal",
            },
          },
        },
        action: {
          kind: "start_workflow",
          workflowScriptPath: "/workspace/automations/telegram.workflow.js",
          instanceIdTemplate: "telegram-${event.id}",
        },
      }),
    ).toThrow();
  });

  test("send_workflow_event actions target an instance id directly or through the store", () => {
    expect(
      automationRouteActionSchema.parse({
        kind: "send_workflow_event",
        remoteWorkflowName: "message-handler",
        target: { kind: "instance_id", template: "route/${event.id}" },
        eventType: "message.received",
      }),
    ).toMatchObject({
      kind: "send_workflow_event",
      workflowName: "automation-codemode-script",
      remoteWorkflowName: "message-handler",
      target: { kind: "instance_id", template: "route/${event.id}" },
      eventType: "message.received",
    });

    expect(
      automationRouteActionSchema.parse({
        kind: "send_workflow_event",
        remoteWorkflowName: "reply-handler",
        target: { kind: "stored_instance_id", keyTemplate: "route/${event.payload.threadId}" },
        eventType: "reply.received",
      }),
    ).toMatchObject({
      kind: "send_workflow_event",
      workflowName: "automation-codemode-script",
      remoteWorkflowName: "reply-handler",
      target: { kind: "stored_instance_id", keyTemplate: "route/${event.payload.threadId}" },
      eventType: "reply.received",
    });

    expect(() =>
      automationRouteActionSchema.parse({
        kind: "send_workflow_event",
        remoteWorkflowName: "reply-handler",
        eventType: "reply.received",
      }),
    ).toThrow();
    expect(() =>
      automationRouteActionSchema.parse({
        kind: "send_workflow_event",
        remoteWorkflowName: "reply-handler",
        target: { kind: "stored_instance_id", keyTemplate: "" },
        eventType: "reply.received",
      }),
    ).toThrow();
    expect(() =>
      automationRouteActionSchema.parse({
        kind: "send_workflow_event",
        target: { kind: "instance_id", template: "route/${event.id}" },
        eventType: "reply.received",
      }),
    ).toThrow();
    expect(() =>
      automationRouteActionSchema.parse({
        kind: "send_workflow_event",
        remoteWorkflowName: "   ",
        target: { kind: "instance_id", template: "route/${event.id}" },
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
        remoteWorkflowName: string;
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
