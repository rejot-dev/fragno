import { test, vi } from "vitest";

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";

import { ApiObject } from "../../../../workers/api.do";
import { AuthObject } from "../../../../workers/auth.do";
import { AutomationsObject } from "../../../../workers/automations.do";
import { BillingObject } from "../../../../workers/billing.do";
import { CodemodeObject } from "../../../../workers/codemode.do";
import { FormsObject } from "../../../../workers/forms.do";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  },
  RpcTarget: class MockRpcTarget {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

const scenarioObjects = {
  API: (input) => new ApiObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  BILLING: (input) => new BillingObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  FORMS: (input) => new FormsObject(input),
  MCP: null,
  TELEGRAM: null,
  UPLOAD: null,
} satisfies LocalBackofficeObjects;

const scope = { kind: "org", orgId: "org-1" } as const;
const run = `async (_event, step) => {
  await step.sleep("cool down", "1 minute");
  return await step.do("finish", async () => "done");
}`;

// Each form the guest evaluated before workflow programs were modules.
const legacyPrograms = {
  definition: `defineWorkflow({ name: "legacy-definition" }, ${run})`,
  run,
  factory: `async () => defineWorkflow({ name: "legacy-factory" }, ${run})`,
} as const;

/** Instance params as they were stored before workflow programs were modules. */
function legacySnapshot(form: keyof typeof legacyPrograms) {
  return {
    program: {
      code: legacyPrograms[form],
      // Snapshots pinned the modules their code imported, never the program itself.
      modules: {},
      dependencies: {},
      workflowName: `legacy-${form}`,
      filename: `/workspace/automations/legacy-${form}.workflow.js`,
    },
    trigger: { type: "manual", payload: {} },
    execution: {
      scope,
      scopeRestriction: null,
      actors: createBackofficeSystemExecution(scope).actors,
      capabilityGrants: [],
    },
  };
}

const forms = Object.keys(legacyPrograms) as (keyof typeof legacyPrograms)[];

test("workflow instances stored before workflow modules resume in every form the guest ran", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "legacy workflow snapshots",
      setup: ({ given }) => [given.organization.exists({ id: scope.orgId })],
      steps: ({ when, then }) => [
        ...forms.map((form) =>
          when.workflow.createInstance({
            orgId: scope.orgId,
            remoteWorkflowName: `legacy-${form}`,
            instanceId: `legacy-${form}-1`,
            params: legacySnapshot(form),
          }),
        ),
        when.time.advance("2 minutes"),
        ...forms.map((form) =>
          then.workflow.instance({
            remoteWorkflowName: `legacy-${form}`,
            status: "complete",
            output: "done",
          }),
        ),
      ],
    }),
  );
});
