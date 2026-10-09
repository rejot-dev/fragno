import { assert, describe, expect, test, vi } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
import { createAutomationsRouteCaller } from "@/fragno/automation/route-callers";
import {
  backofficeFiles,
  defineBackofficeScenario,
  runBackofficeScenario,
} from "@/fragno/automation/scenario";

import { InMemoryApiObject } from "../../../../workers/api.do";
import { InMemoryAuthObject } from "../../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../../workers/automations.do";
import { InMemoryFormsObject } from "../../../../workers/forms.do";
import { InMemoryUploadObject } from "../../../../workers/upload.do";
import { AutomationDetailRows } from "./detail-rows";
import { automationRouteActionDetailRows } from "./route-action";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }
  class MockRpcTarget {}
  class MockWorkerEntrypoint {}
  return {
    DurableObject: MockDurableObject,
    RpcTarget: MockRpcTarget,
    WorkerEntrypoint: MockWorkerEntrypoint,
  };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

describe("route authority inspector scenario", () => {
  test("shows persisted execution identities, explicit grants, inherited permissions, and empty grants", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "route inspector explains whose permissions apply",
        files: backofficeFiles.workspaceStarter(),
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ when, then }) => [
          when.router.createRoute({
            orgId: "org-1",
            id: "scheduled",
            name: "Scheduled connections",
            enabled: true,
            priority: 1000,
            trigger: {
              kind: "schedule",
              cadence: { kind: "once", at: "2030-01-01T00:00:00.000Z" },
            },
            action: {
              kind: "start_workflow",
              authority: {
                kind: "organization-automation",
                grants: [
                  BACKOFFICE_PERMISSION.connections.read,
                  BACKOFFICE_PERMISSION.upload.modify,
                ],
              },
              workflowScriptPath: "/workspace/automations/connections.workflow.js",
              instanceIdTemplate: "connections-${event.id}",
            },
          }),
          when.router.createRoute({
            orgId: "org-1",
            id: "linked",
            name: "Incoming sender",
            enabled: true,
            priority: 1000,
            trigger: {
              kind: "event",
              source: "telegram",
              eventType: "message.received",
              matcher: null,
            },
            action: {
              kind: "start_workflow",
              authority: { kind: "linked-user", grants: "inherit" },
              workflowScriptPath: "/workspace/automations/telegram.workflow.js",
              instanceIdTemplate: "telegram-${event.id}",
            },
          }),
          when.router.createRoute({
            orgId: "org-1",
            id: "delegated",
            name: "Restricted incoming user",
            enabled: true,
            priority: 1000,
            trigger: { kind: "event", source: "test", eventType: "requested", matcher: null },
            action: {
              kind: "start_workflow",
              authority: { kind: "delegated-user", grants: [BACKOFFICE_PERMISSION.store.modify] },
              workflowScriptPath: "/workspace/automations/store.workflow.js",
              instanceIdTemplate: "store-${event.id}",
            },
          }),
          when.router.createRoute({
            orgId: "org-1",
            id: "empty",
            name: "No grants",
            enabled: true,
            priority: 1000,
            trigger: { kind: "event", source: "test", eventType: "requested", matcher: null },
            action: {
              kind: "start_workflow",
              authority: { kind: "organization-automation", grants: [] },
              workflowScriptPath: "/workspace/automations/empty.workflow.js",
              instanceIdTemplate: "empty-${event.id}",
            },
          }),
          then.assert(
            "render authority details from routes read back through the API",
            async (ctx) => {
              const call = createAutomationsRouteCaller({
                object: ctx.runtime.objects.automations.forOrg("org-1"),
                context: {
                  execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                  propagationContext: null,
                },
              });
              const response = await call("GET", "/routes");
              assert(response.type === "json", "Expected route records.");
              for (const id of ["scheduled", "linked", "delegated", "empty"]) {
                const route = response.data.find((route) => route.id === id);
                if (!route) {
                  throw new Error(`Missing route ${id}.`);
                }
                const rows = automationRouteActionDetailRows(route, {
                  scriptLink: null,
                  labelSet: "inspector",
                });
                const markup = renderToStaticMarkup(
                  createElement(AutomationDetailRows, {
                    rows,
                    layout: "inspector",
                  }),
                );
                expect(markup).toContain("Runs as");
                expect(markup).toContain("Authority mode");
                expect(markup).toContain("Permissions");
                if (id === "scheduled") {
                  expect(markup).toContain("Organization-owned automation");
                  expect(markup).toContain("organization-automation");
                  expect(markup).toContain("connections.read\nupload.modify");
                  expect(markup).toContain("whitespace-pre-wrap");
                } else if (id === "linked") {
                  expect(markup).toContain("Backoffice user linked to the incoming sender");
                  expect(rows).toContainEqual({
                    label: "Permissions",
                    value: "User's current permissions — no additional route restriction",
                  });
                } else if (id === "delegated") {
                  expect(markup).toContain("Backoffice user carried by the incoming event");
                  expect(markup).toContain("store.modify");
                  expect(rows).toContainEqual({
                    label: "Permission basis",
                    value:
                      "These grants restrict the user's current permissions; they do not add permissions.",
                  });
                } else {
                  expect(markup).toContain("None — no protected operations granted");
                }
              }
            },
          ),
          then.hooks.noFailed({ orgId: "org-1", fragments: ["automations"] }),
        ],
      }),
    );
  });
});
