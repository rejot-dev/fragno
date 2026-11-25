import { assert, expect, test } from "vitest";

import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import {
  type BackofficeExecutionContext,
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { appendAutomationDelegate } from "@/fragno/automation/authority";
import { createAutomationsRouteCaller } from "@/fragno/automation/route-callers";
import {
  type BackofficeScenarioContext,
  backofficeFiles,
  defineBackofficeScenario,
  runBackofficeScenario,
} from "@/fragno/automation/scenario";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { ApiObject } from "../../../../workers/api-object";
import { AppInstallationsObject } from "../../../../workers/app-installations-object";
import { AppsObject } from "../../../../workers/apps-object";
import { AuthObject } from "../../../../workers/auth-object";
import { AutomationsObject } from "../../../../workers/automations-object";
import { BillingObject } from "../../../../workers/billing-object";
import { CodemodeObject } from "../../../../workers/codemode-object";
import { McpObject } from "../../../../workers/mcp-object";
import { UploadObject } from "../../../../workers/upload-object";
import { piAgentActor } from "./pi-agent-actor";

const scenarioObjects = {
  API: (input) => new ApiObject(input),
  APPS: (input) => new AppsObject(input),
  APP_INSTALLATIONS: (input) => new AppInstallationsObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  BILLING: (input) => new BillingObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  MCP: (input) => new McpObject(input),
  PI_MANAGER: allLocalObjects.PI_MANAGER,
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

const personal = { kind: "user", userId: "user-1", jurisdiction: null } as const;
const member = createBackofficeUserExecution({ scope: personal, userId: "user-1" });

/** A terminal acting as `execution`, as a turn's tools or a person's shell do. */
async function terminal(ctx: BackofficeScenarioContext, execution: BackofficeExecutionContext) {
  const context = createRouteBackedRuntimeContext({
    emitter: { kind: "caller" },
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution,
  });
  assert(context.stateBackend);
  return (
    await createInteractiveBashHost({
      context: { ...context, stateBackend: context.stateBackend },
    })
  ).bash;
}

/** The member's own work, through the helper agent: what the helper's turn leaves behind. */
async function helperTerminal(ctx: BackofficeScenarioContext) {
  return await terminal(
    ctx,
    appendAutomationDelegate({
      execution: { ...member, kind: "deferred" },
      delegate: piAgentActor(personal, "helper"),
    }),
  );
}

function storeRoute(id: string, grants: unknown) {
  return JSON.stringify({
    id,
    name: id,
    trigger: { kind: "event", source: "ledger", eventType: `${id}.requested` },
    action: {
      kind: "start_workflow",
      authority: { kind: "delegated-user", grants },
      workflowScriptPath: "/workspace/automations/record.workflow.js",
      instanceIdTemplate: `${id}-\${event.id}`,
    },
  });
}

async function storeValue(ctx: BackofficeScenarioContext, key: string) {
  const store = createAutomationsRouteCaller({
    object: ctx.runtime.objects.automations.for(personal),
    context: { execution: createBackofficeSystemExecution(personal), propagationContext: null },
  });
  const response = await store("GET", "/store/get", { query: { key } });
  if (response.type === "json") {
    return response.data.value;
  }
  assert(response.type === "error" && response.error.code === "STORE_ENTRY_NOT_FOUND");
  return null;
}

test("an agent's definition narrows the work its turns leave behind", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "agent definitions narrow persisted work",
      options: { allowErroredWorkflows: true },
      files: backofficeFiles.custom({
        workspace: {
          "automations/record.workflow.js": `export default defineWorkflow(
  { name: "record" },
  async (event, step) => {
    await step.do("record", async () => {
      await store.set({ key: event.eventType, value: "written" });
    });
  },
);
`,
        },
      }),
      setup: ({ given }) => [
        given.auth.user({ id: "user-1", role: "user" }),
        given.codemode.run({
          scope: personal,
          code: `async () => await pi.createAgent({
            agentName: "helper",
            description: "Sets up automations.",
            model: null,
            permissions: ["router.*", "events.emit"],
            instructions: "",
            category: null,
          })`,
        }),
      ],
      steps: ({ then }) => [
        then.assert("the helper cannot save a route that may do more than it", async (ctx) => {
          const helper = await helperTerminal(ctx);
          const inherited = await helper.exec(
            `router.create --json '${storeRoute("inherited", "inherit")}'`,
          );
          expect(inherited.exitCode).not.toBe(0);
          expect(inherited.stderr).toMatch(
            /Agent 'helper' is not granted \S+ on everything, so it cannot set up work that acts with all of a person's permissions\./,
          );
          const explicit = await helper.exec(
            `router.create --json '${storeRoute("explicit", [BACKOFFICE_PERMISSION.store.modify])}'`,
          );
          expect(explicit.exitCode).not.toBe(0);
          expect(explicit.stderr).toContain("Agent 'helper' is not granted store.modify");
        }),
        then.assert("the member saves a route that acts with their permissions", async (ctx) => {
          const own = await terminal(ctx, member);
          const created = await own.exec(
            `router.create --json '${storeRoute("recorded", "inherit")}'`,
          );
          expect(created.exitCode, created.stderr).toBe(0);
        }),
        then.assert("what the helper fires, the route may only do as the helper", async (ctx) => {
          const helper = await helperTerminal(ctx);
          const fired = await helper.exec(
            "events.fire --source ledger --event-type recorded.requested",
          );
          expect(fired.exitCode, fired.stderr).toBe(0);
          await ctx.drain();
          expect(await storeValue(ctx, "recorded.requested")).toBeNull();
        }),
        then.assert("once the helper may write the store, so may its events", async (ctx) => {
          await ctx.runCodemode({
            scope: personal,
            code: `async () => await pi.updateAgent({
              agentName: "helper",
              description: "Sets up automations.",
              model: null,
              permissions: ["router.*", "events.emit", "store.*"],
              instructions: "",
              category: null,
            })`,
          });
          const helper = await helperTerminal(ctx);
          const fired = await helper.exec(
            "events.fire --source ledger --event-type recorded.requested",
          );
          expect(fired.exitCode, fired.stderr).toBe(0);
          await ctx.drain();
          assert((await storeValue(ctx, "recorded.requested")) === "written");
        }),
      ],
    }),
  );
});
