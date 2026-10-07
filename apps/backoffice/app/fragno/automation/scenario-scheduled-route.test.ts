import { assert, describe, expect, test, vi } from "vitest";

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

import { backofficeFiles, defineBackofficeScenario, runBackofficeScenario } from "./scenario";

describe("scheduled automation route scenario", () => {
  test.each(["linked-user", "delegated-user"] as const)(
    "rejects scheduled %s authority on create and partial update without changing routes",
    async (kind) => {
      await runBackofficeScenario(
        defineBackofficeScenario({
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

  test("schedules can still send workflow events without workflow-start authority", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
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
