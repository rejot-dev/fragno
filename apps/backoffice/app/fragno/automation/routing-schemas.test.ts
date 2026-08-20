import { describe, expect, test } from "vitest";

import { zodSchemaToTypeScriptRender } from "@/lib/zod/zod-formatter";

import { automationRouteActionSchema, automationRouteCreateInputSchema } from "./routing-schemas";

describe("automation routing schemas", () => {
  test.each(["workflowName", "remoteWorkflowName"])(
    "start_workflow actions reject caller-supplied %s",
    (field) => {
      expect(() =>
        automationRouteActionSchema.parse({
          kind: "start_workflow",
          authority: { kind: "organization-automation" },
          workflowScriptPath: "/workspace/automations/daily-digest.workflow.js",
          instanceIdTemplate: "daily-digest-${event.id}",
          [field]: "caller-supplied-name",
        }),
      ).toThrow();
    },
  );

  test("requires an explicit authority mode for workflow-start routes", () => {
    expect(() =>
      automationRouteActionSchema.parse({
        kind: "start_workflow",
        workflowScriptPath: "/workspace/automations/telegram-hello.workflow.js",
        instanceIdTemplate: "telegram-hello-${event.id}",
      }),
    ).toThrow();
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
        "  authority: {",
        '    kind: "delegated-user";',
        "  } | {",
        '    kind: "organization-automation";',
        "  };",
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
          authority: { kind: "organization-automation" },
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
          authority: { kind: "organization-automation" },
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
          authority: { kind: "organization-automation" },
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
          authority: { kind: "organization-automation" },
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
          authority: { kind: "organization-automation" },
          workflowScriptPath: "/workspace/automations/telegram.workflow.js",
          instanceIdTemplate: "telegram-${event.id}",
        },
      }),
    ).toThrow();
  });

  test("accepts reclassify_event actions with an explicit event identity", () => {
    expect(
      automationRouteActionSchema.parse({
        kind: "reclassify_event",
        source: "github",
        eventType: "issues.opened",
        payload: {
          kind: "projection",
          fields: { issue: "$.payload.issue" },
        },
      }),
    ).toEqual({
      kind: "reclassify_event",
      source: "github",
      eventType: "issues.opened",
      payload: {
        kind: "projection",
        fields: { issue: "$.payload.issue" },
      },
    });

    expect(() =>
      automationRouteActionSchema.parse({
        kind: "reclassify_event",
        source: "github",
        eventType: "",
        payload: { kind: "projection", fields: { issue: "$.payload.issue" } },
      }),
    ).toThrow();

    expect(() =>
      automationRouteActionSchema.parse({
        kind: "reclassify_event",
        source: "github",
        eventType: "issues.opened",
        payload: { kind: "projection", fields: { issue: "payload.issue" } },
      }),
    ).toThrow(/Projection paths must start with/);
  });

  test("send_workflow_event actions target an instance id directly or through the store", () => {
    expect(
      automationRouteActionSchema.parse({
        kind: "send_workflow_event",
        target: { kind: "instance_id", template: "route/${event.id}" },
        eventType: "message.received",
      }),
    ).toEqual({
      kind: "send_workflow_event",
      target: { kind: "instance_id", template: "route/${event.id}" },
      eventType: "message.received",
    });

    expect(
      automationRouteActionSchema.parse({
        kind: "send_workflow_event",
        target: { kind: "stored_instance_id", keyTemplate: "route/${event.payload.threadId}" },
        eventType: "reply.received",
      }),
    ).toEqual({
      kind: "send_workflow_event",
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

  test.each(["workflowName", "remoteWorkflowName"])(
    "send_workflow_event actions reject caller-supplied %s",
    (field) => {
      expect(() =>
        automationRouteActionSchema.parse({
          kind: "send_workflow_event",
          target: { kind: "instance_id", template: "route/${event.id}" },
          eventType: "reply.received",
          [field]: "caller-supplied-name",
        }),
      ).toThrow();
    },
  );

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
