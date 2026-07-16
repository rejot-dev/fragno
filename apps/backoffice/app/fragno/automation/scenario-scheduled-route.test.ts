import { describe, test, vi } from "vitest";

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
    const route = event.payload.automationEvent.payload;
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
            orgId: "org-1",
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
    workflowName: "automation-codemode-script",
    remoteWorkflowName: "scheduled-digest",
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
