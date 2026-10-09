import { assert, describe, expect, test, vi } from "vitest";

import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";

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

import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";

import { InMemoryApiObject } from "../../../workers/api.do";
import { InMemoryAppInstallationsObject } from "../../../workers/app-installations.do";
import { InMemoryAppsObject } from "../../../workers/apps.do";
import { InMemoryAuthObject } from "../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../workers/automations.do";
import { InMemoryFormsObject } from "../../../workers/forms.do";
import { InMemoryMcpObject } from "../../../workers/mcp.do";
import { InMemoryTelegramObject } from "../../../workers/telegram.do";
import { InMemoryUploadObject } from "../../../workers/upload.do";
import { createRouteBackedAutomationRouterRuntime } from "./routing-route-runtime";
import { backofficeFiles, defineBackofficeScenario, runBackofficeScenario } from "./scenario";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  APPS: (input) => new InMemoryAppsObject(input),
  APP_INSTALLATIONS: (input) => new InMemoryAppInstallationsObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  MCP: (input) => new InMemoryMcpObject(input),
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

describe("scheduled automation route scenario", () => {
  test.each(["linked-user", "delegated-user"] as const)(
    "rejects scheduled %s authority on create and partial update without changing routes",
    async (kind) => {
      await runBackofficeScenario(
        defineBackofficeScenario({
          objects: scenarioObjects,
          name: `scheduled routes reject ${kind} authority`,
          files: backofficeFiles.workspaceStarter(),
          setup: ({ given }) => [
            given.organization.exists({ id: "org-1", name: "Ada Labs" }),
            given.router.route({
              orgId: "org-1",
              id: "scheduled-route",
              name: "Scheduled route",
              enabled: true,
              priority: 1000,
              trigger: {
                kind: "schedule",
                cadence: { kind: "once", at: "2030-01-01T00:00:00.000Z" },
              },
              action: {
                kind: "start_workflow",
                authority: { kind: "organization-automation", grants: [] },
                workflowScriptPath: "/workspace/automations/digest.workflow.js",
                instanceIdTemplate: "scheduled-${event.id}",
              },
            }),
            given.router.route({
              orgId: "org-1",
              id: "user-route",
              name: "User route",
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
                authority: { kind, grants: "inherit" },
                workflowScriptPath: "/workspace/automations/digest.workflow.js",
                instanceIdTemplate: "user-${event.id}",
              },
            }),
          ],
          steps: ({ then }) => [
            then.assert(
              "reject invalid creates and both partial-update directions",
              async (ctx) => {
                const object = ctx.runtime.objects.automations.forOrg("org-1");
                const execution = createBackofficeSystemExecution({ kind: "org", orgId: "org-1" });
                const action = {
                  kind: "start_workflow",
                  authority: { kind, grants: "inherit" },
                  workflowScriptPath: "/workspace/automations/digest.workflow.js",
                  instanceIdTemplate: "invalid-${event.id}",
                };
                const trigger = {
                  kind: "schedule",
                  cadence: { kind: "once", at: "2030-01-01T00:00:00.000Z" },
                };
                for (const mutation of [
                  {
                    method: "POST",
                    path: "/routes",
                    body: { id: "invalid-route", name: "Invalid route", trigger, action },
                  },
                  { method: "PATCH", path: "/routes/scheduled-route", body: { action } },
                  { method: "PATCH", path: "/routes/user-route", body: { trigger } },
                ]) {
                  const response = await object.http.fetchAuthorized(
                    new Request(`https://automations.do/api/automations${mutation.path}`, {
                      method: mutation.method,
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify(mutation.body),
                    }),
                    { execution, propagationContext: null },
                  );
                  assert(response.status === 400, await response.clone().text());
                  expect(await response.text()).toContain(
                    "Scheduled workflows require organization-automation authority",
                  );
                }
                for (const configuration of [
                  { trigger: { kind: "unknown" }, action },
                  { trigger, action: { kind: "unknown" } },
                  {
                    trigger: { kind: "event", source: "telegram", eventType: "" },
                    action,
                  },
                  {
                    trigger: { kind: "schedule", cadence: { kind: "unknown" } },
                    action: {
                      ...action,
                      authority: { kind: "organization-automation", grants: [] },
                    },
                  },
                ]) {
                  const response = await object.http.fetchAuthorized(
                    new Request("https://automations.do/api/automations/routes", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({
                        id: "malformed-route",
                        name: "Malformed",
                        ...configuration,
                      }),
                    }),
                    { execution, propagationContext: null },
                  );
                  assert(response.status === 400, await response.clone().text());
                  const message = await response.text();
                  expect(message).toContain("Validation failed");
                  expect(message).not.toContain(
                    "Scheduled workflows require organization-automation authority",
                  );
                }
              },
            ),
            then.router.missing({ orgId: "org-1", id: "invalid-route" }),
            then.router.route({
              orgId: "org-1",
              id: "scheduled-route",
              trigger: { kind: "schedule" },
              action: {
                kind: "start_workflow",
                authority: { kind: "organization-automation", grants: [] },
              },
            }),
            then.router.route({
              orgId: "org-1",
              id: "user-route",
              trigger: { kind: "event" },
              action: { kind: "start_workflow", authority: { kind, grants: "inherit" } },
            }),
            then.assert("accept changing trigger and authority together", async (ctx) => {
              const response = await ctx.runtime.objects.automations
                .forOrg("org-1")
                .http.fetchAuthorized(
                  new Request("https://automations.do/api/automations/routes/user-route", {
                    method: "PATCH",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      trigger: {
                        kind: "schedule",
                        cadence: { kind: "once", at: "2030-01-01T00:00:00.000Z" },
                      },
                      action: {
                        kind: "start_workflow",
                        authority: { kind: "organization-automation", grants: [] },
                        workflowScriptPath: "/workspace/automations/digest.workflow.js",
                        instanceIdTemplate: "scheduled-${event.id}",
                      },
                    }),
                  }),
                  {
                    execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                    propagationContext: null,
                  },
                );
              assert(response.status === 200, await response.clone().text());
            }),
            then.router.route({
              orgId: "org-1",
              id: "user-route",
              trigger: { kind: "schedule" },
              action: {
                kind: "start_workflow",
                authority: { kind: "organization-automation", grants: [] },
              },
            }),
            then.hooks.noFailed({ orgId: "org-1", fragments: ["automations"] }),
          ],
        }),
      );
    },
  );

  test.each(["linked-user", "delegated-user"] as const)(
    "legacy scheduled %s routes remain manageable but cannot be re-enabled without repair",
    async (kind) => {
      const action = {
        kind: "start_workflow",
        authority: { kind, grants: "inherit" },
        workflowScriptPath: "/workspace/automations/digest.workflow.js",
        instanceIdTemplate: "legacy-${event.id}",
      } as const;
      const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-legacy-schedule-"));
      try {
        await runBackofficeScenario(
          defineBackofficeScenario({
            objects: scenarioObjects,
            name: `manage legacy scheduled ${kind} route`,
            options: { sqliteDataDirectory: directory },
            setup: ({ given }) => [
              given.organization.exists({ id: "org-1", name: "Ada Labs" }),
              given.router.route({
                orgId: "org-1",
                id: "legacy-route",
                name: "Legacy route",
                enabled: true,
                priority: 1000,
                trigger: {
                  kind: "schedule",
                  cadence: { kind: "once", at: "2030-01-01T00:00:00.000Z" },
                },
                action: {
                  kind: "start_workflow",
                  authority: { kind: "organization-automation", grants: [] },
                  workflowScriptPath: "/workspace/automations/digest.workflow.js",
                  instanceIdTemplate: "legacy-${event.id}",
                },
              }),
            ],
            steps: ({ then }) => [
              then.assert("seed the historical authority directly in SQLite", async () => {
                let changed = 0;
                for (const file of await readdir(directory)) {
                  if (!file.startsWith("automations-") || !file.endsWith(".sqlite")) {
                    continue;
                  }
                  const database = new Database(path.join(directory, file));
                  try {
                    const tables = database
                      .prepare(
                        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'automation_route%' AND name NOT LIKE 'automation_route_schedule_state%'",
                      )
                      .all() as { name: string }[];
                    for (const table of tables) {
                      // Historical data must bypass current create validation to exercise migration behavior.
                      changed += database
                        .prepare(`UPDATE "${table.name}" SET action = ? WHERE id = ?`)
                        .run(JSON.stringify(action), "legacy-route").changes;
                    }
                  } finally {
                    database.close();
                  }
                }
                expect(changed).toBe(1);
              }),
              then.assert(
                "read, edit, disable, reject unsafe changes, and repair the route",
                async (ctx) => {
                  const router = createRouteBackedAutomationRouterRuntime({
                    object: ctx.runtime.objects.automations.forOrg("org-1"),
                    execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                  });
                  const route = await router.getRoute({ id: "legacy-route" });
                  assert(route);
                  expect(route.action).toMatchObject({ authority: { kind, grants: "inherit" } });
                  expect(await router.listRoutes()).toContainEqual(route);
                  expect(
                    await router.updateRoute({
                      id: route.id,
                      name: "Renamed legacy route",
                      priority: 42,
                    }),
                  ).toMatchObject({ name: "Renamed legacy route", priority: 42, enabled: true });
                  expect(await router.updateRoute({ id: route.id, enabled: false })).toMatchObject({
                    enabled: false,
                  });
                  expect(
                    await router.updateRoute({
                      id: route.id,
                      description: "Awaiting migration",
                    }),
                  ).toMatchObject({ description: "Awaiting migration", enabled: false });
                  expect(await router.updateRoute({ id: route.id, action })).toMatchObject({
                    action,
                    enabled: false,
                  });
                  for (const patch of [
                    { enabled: true },
                    { action: { ...action, instanceIdTemplate: "changed-${event.id}" } },
                    {
                      trigger: {
                        kind: "schedule",
                        cadence: { kind: "once", at: "2030-01-02T00:00:00.000Z" },
                      },
                    },
                  ] as const) {
                    await expect(router.updateRoute({ id: route.id, ...patch })).rejects.toThrow(
                      "Scheduled workflows require organization-automation authority",
                    );
                  }
                  expect(await router.getRoute({ id: route.id })).toMatchObject({
                    enabled: false,
                    description: "Awaiting migration",
                    action: route.action,
                    trigger: route.trigger,
                  });
                  await router.updateRoute({
                    id: route.id,
                    enabled: true,
                    action: {
                      kind: "start_workflow",
                      authority: { kind: "organization-automation", grants: [] },
                      workflowScriptPath: "/workspace/automations/digest.workflow.js",
                      instanceIdTemplate: "legacy-${event.id}",
                    },
                  });
                },
              ),
              then.router.route({
                orgId: "org-1",
                id: "legacy-route",
                enabled: true,
                name: "Renamed legacy route",
                priority: 42,
                description: "Awaiting migration",
                action: {
                  kind: "start_workflow",
                  authority: { kind: "organization-automation", grants: [] },
                },
              }),
              then.hooks.noFailed({ orgId: "org-1", fragments: ["automations"] }),
            ],
          }),
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("schedules can still send workflow events without workflow-start authority", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "non-start-workflow scheduled actions remain valid",
        files: backofficeFiles.workspaceStarter(),
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ when, then }) => [
          when.router.createRoute({
            orgId: "org-1",
            id: "scheduled-signal",
            name: "Scheduled signal",
            enabled: true,
            priority: 1000,
            trigger: {
              kind: "schedule",
              cadence: { kind: "once", at: "2030-01-01T00:00:00.000Z" },
            },
            action: {
              kind: "send_workflow_event",
              target: { kind: "instance_id", template: "digest" },
              eventType: "digest-requested",
            },
          }),
          when.router.updateRoute({
            orgId: "org-1",
            id: "scheduled-signal",
            trigger: {
              kind: "schedule",
              cadence: { kind: "once", at: "2030-01-02T00:00:00.000Z" },
            },
          }),
          then.router.route({
            orgId: "org-1",
            id: "scheduled-signal",
            trigger: {
              kind: "schedule",
              cadence: { kind: "once", at: "2030-01-02T00:00:00.000Z" },
            },
            action: { kind: "send_workflow_event", eventType: "digest-requested" },
          }),
          then.hooks.noFailed({ orgId: "org-1", fragments: ["automations"] }),
        ],
      }),
    );
  });

  test("a scheduled route starts its workflow", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "scheduled route starts a workflow",
        files: backofficeFiles.workspaceStarter(),
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.direct.file({
            orgId: "org-1",
            path: "/workspace/automations/scheduled-digest.workflow.js",
            content: `defineWorkflow(
  { name: "scheduled-digest" },
  async (event, step) => {
    const route = event.payload;
    return await step.do("record scheduled route", async () => ({
      routeId: route.id,
      routeName: route.name,
    }));
  },
);
`,
          }),
        ],
        steps: ({ when, then }) => [
          when.codemode.run({
            scope: { kind: "org", orgId: "org-1" },
            label: "create scheduled route",
            code: `async () => await router.create({
  id: "daily-digest",
  name: "Daily digest",
  enabled: true,
  trigger: {
    kind: "schedule",
    cadence: {
      kind: "once",
      at: new Date(Date.now() + 60_000).toISOString(),
    },
  },
  action: {
    kind: "start_workflow",
    authority: { kind: "organization-automation", grants: [] },
    workflowScriptPath: "/workspace/automations/scheduled-digest.workflow.js",
    instanceIdTemplate: "scheduled-\${event.payload.id}",
  },
})`,
            assertToolCalls: ["router.create"],
          }),
          then.router.route({
            orgId: "org-1",
            id: "daily-digest",
            trigger: { kind: "schedule", cadence: { kind: "once" } },
          }),
          when.time.advance("2 minutes"),
          then.workflow.instance({
            remoteWorkflowName: "scheduled-digest",
            instanceId: "scheduled-daily-digest",
            status: "complete",
            actors: {
              initiator: {
                scope: "internal",
                type: "schedule",
                id: "daily-digest",
                role: "initiator",
              },
              principal: {
                scope: "internal",
                type: "automation",
                id: "automation-route:daily-digest",
                role: "principal",
              },
              delegation: [],
            },
            output: { routeId: "daily-digest", routeName: "Daily digest" },
          }),
          then.router.route({
            orgId: "org-1",
            id: "daily-digest",
            nextOccurrenceAt: null,
          }),
          then.hooks.noPending({ orgId: "org-1", fragments: ["automations"] }),
          then.hooks.noFailed({ orgId: "org-1", fragments: ["automations"] }),
        ],
      }),
    );
  });
});
