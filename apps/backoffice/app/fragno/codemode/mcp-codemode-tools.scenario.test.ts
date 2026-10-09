import { assert, describe, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
import { CODEMODE_WORKFLOW } from "@/fragno/automation/engine/codemode-invocation";
import { createWorkflowsRouteCaller } from "@/fragno/automation/route-callers";
import {
  backofficeFiles,
  defineBackofficeScenario,
  runBackofficeScenario,
} from "@/fragno/automation/scenario";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import { InMemoryApiObject } from "../../../workers/api.do";
import { InMemoryAppInstallationsObject } from "../../../workers/app-installations.do";
import { InMemoryAppsObject } from "../../../workers/apps.do";
import { InMemoryAuthObject } from "../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../workers/automations.do";
import { InMemoryFormsObject } from "../../../workers/forms.do";
import { InMemoryMcpObject } from "../../../workers/mcp.do";
import { InMemoryTelegramObject } from "../../../workers/telegram.do";
import { InMemoryUploadObject } from "../../../workers/upload.do";
import { runBackofficeCodemode } from "./execute";

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

const cases = [
  {
    name: "missing discovery permission inside a durable step",
    body: 'return await step.do("call MCP", { retries: { limit: 0, delay: 0 } }, async () => await mcp_agensi.search({}));',
    grants: [],
    expectedName: "BackofficeForbiddenError",
    expectedMessage: "Required permission: mcp.servers.read.",
    stepError: true,
  },
  {
    name: "missing discovery permission outside a durable step",
    body: "return await mcp_agensi.search({});",
    grants: [],
    expectedName: "BackofficeForbiddenError",
    expectedMessage: "Required permission: mcp.servers.read.",
    stepError: false,
  },
  {
    name: "unrelated script error without MCP permission",
    body: "return await missingHelper();",
    grants: [],
    expectedName: "ReferenceError",
    expectedMessage: "missingHelper is not defined",
    stepError: false,
  },
  {
    name: "unknown provider after successful discovery",
    body: "return await mcp_agensi.search({});",
    grants: [BACKOFFICE_PERMISSION.mcp.serversRead],
    expectedName: "ReferenceError",
    expectedMessage: "mcp_agensi is not defined",
    stepError: false,
  },
  {
    name: "missing tool call permission after successful discovery",
    body: 'return await step.do("call MCP", { retries: { limit: 0, delay: 0 } }, async () => await mcp.callTool({ slug: "agensi", name: "search", arguments: {} }));',
    grants: [BACKOFFICE_PERMISSION.mcp.serversRead],
    expectedName: "BackofficeForbiddenError",
    expectedMessage: "Required permission: mcp.tools.call.",
    stepError: true,
  },
];

describe("MCP permission diagnostic scenarios", () => {
  test("local immediate execution explains denied discovery without blocking other scripts", async () => {
    const scope = { kind: "org" as const, orgId: "org-1" };
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "local immediate MCP permission diagnostics",
        files: backofficeFiles.workspaceStarter(),
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.router.route({
            orgId: "org-1",
            id: "mcp-immediate",
            name: "MCP immediate",
            enabled: false,
            priority: 1000,
            trigger: {
              kind: "schedule",
              cadence: { kind: "once", at: "2030-01-01T00:00:00.000Z" },
            },
            action: {
              kind: "start_workflow",
              authority: { kind: "organization-automation", grants: [] },
              workflowScriptPath: "/workspace/automations/unused.workflow.js",
              instanceIdTemplate: "unused",
            },
          }),
        ],
        steps: ({ then }) => [
          then.assert("denied MCP and unrelated scripts retain distinct outcomes", async (ctx) => {
            const systemExecution = createBackofficeSystemExecution(scope);
            const toolContext = createBackofficeToolContext(
              createCodemodeRouteBackedRuntimeContext({
                runtime: ctx.runtime.services,
                kernel: new BackofficeKernel(ctx.runtime.services),
                execution: {
                  ...systemExecution,
                  actors: {
                    ...systemExecution.actors,
                    principal: {
                      scope: "internal",
                      type: "automation",
                      id: "automation-route:mcp-immediate",
                      role: "principal",
                    },
                  },
                },
                billingOrganizationId: null,
              }),
            );
            assert(ctx.runtime.env.codemode);
            const options = {
              env: ctx.runtime.env.codemode,
              toolContext,
              families: runtimeToolFamilies,
            };
            const denied = await runBackofficeCodemode({
              ...options,
              code: "async () => await mcp_agensi.search({})",
            });
            expect(denied.error).toContain("Required permission: mcp.servers.read.");
            expect(denied.error).toContain("Calling MCP tools also requires mcp.tools.call.");
            const unrelated = await runBackofficeCodemode({
              ...options,
              code: "async () => await missingHelper()",
            });
            assert(unrelated.error === "missingHelper is not defined");
            const successful = await runBackofficeCodemode({ ...options, code: "async () => 42" });
            expect(successful.error).toBeUndefined();
            assert(successful.result === 42);
          }),
        ],
      }),
    );
  });

  test.each(cases)(
    "$name",
    async ({ name, body, grants, expectedName, expectedMessage, stepError }) => {
      await runBackofficeScenario(
        defineBackofficeScenario({
          objects: scenarioObjects,
          name,
          files: backofficeFiles.workspaceStarter({
            "automations/mcp-diagnostic.workflow.js": `defineWorkflow({ name: "mcp-diagnostic" }, async (_event, step) => { ${body} });`,
          }),
          setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
          steps: ({ when, then }) => [
            when.codemode.run({
              scope: { kind: "org", orgId: "org-1" },
              code: `async () => await router.create({
              id: "mcp-diagnostic",
              name: "MCP diagnostic",
              enabled: true,
              trigger: { kind: "schedule", cadence: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() } },
              action: {
                kind: "start_workflow",
                authority: { kind: "organization-automation", grants: ${JSON.stringify(grants)} },
                workflowScriptPath: "/workspace/automations/mcp-diagnostic.workflow.js",
                instanceIdTemplate: "mcp-diagnostic-1",
              },
            })`,
            }),
            when.time.advance("2 minutes"),
            then.workflow.instance({
              remoteWorkflowName: "mcp-diagnostic",
              instanceId: "mcp-diagnostic-1",
              status: "errored",
            }),
            then.assert(
              "the instance and durable step retain the actionable error",
              async (ctx) => {
                const workflows = createWorkflowsRouteCaller({
                  object: ctx.runtime.objects.automations.forOrg("org-1"),
                  context: {
                    execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                    propagationContext: null,
                  },
                });
                const pathParams = {
                  workflowName: CODEMODE_WORKFLOW,
                  instanceId: "mcp-diagnostic-1",
                };
                const instance = await workflows("GET", "/:workflowName/instances/:instanceId", {
                  pathParams,
                });
                assert(instance.type === "json");
                expect(instance.data.details.error?.message).toContain(expectedMessage);
                if (expectedMessage.includes("servers.read")) {
                  expect(instance.data.details.error?.message).toContain(
                    "Calling MCP tools also requires mcp.tools.call.",
                  );
                  expect(instance.data.details.error?.message).not.toContain(
                    "mcp_agensi is not defined",
                  );
                }
                if (stepError) {
                  const history = await workflows(
                    "GET",
                    "/:workflowName/instances/:instanceId/history",
                    { pathParams },
                  );
                  assert(history.type === "json");
                  expect(history.data.steps).toContainEqual(
                    expect.objectContaining({
                      name: "call MCP",
                      status: "errored",
                      error: expect.objectContaining({
                        name: expectedName,
                        message: expect.stringContaining(expectedMessage),
                      }),
                    }),
                  );
                }
              },
            ),
          ],
          options: { allowErroredWorkflows: true },
        }),
      );
    },
  );
});
