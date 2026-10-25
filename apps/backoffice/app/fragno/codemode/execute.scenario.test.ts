import { afterAll, beforeAll, assert, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { allBackofficePermissionRequirements } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import {
  backofficeScopePathSegment,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { createCodemodeNodeExecutor } from "@fragno-dev/codemode/remote/codemode-node-executor";
import { createCodemodeTestServer } from "@fragno-dev/codemode/testing/codemode-test-server";

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import {
  backofficeExecutionScopeRestriction,
  createBackofficeUserExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { createAutomationsRouteCaller } from "@/fragno/automation/route-callers";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { createBackofficeAgentContext } from "@/fragno/pi/agent/backoffice-agent-context";
import { createCodemodeTool } from "@/fragno/pi/extensions/backoffice/codemode-tool";

let server: Awaited<ReturnType<typeof createCodemodeTestServer>>;
beforeAll(async () => {
  server = await createCodemodeTestServer();
});
afterAll(async () => {
  await server?.close();
});

const owner = { kind: "org", orgId: "acme" } as const;

function executionTool(ctx: BackofficeScenarioContext, execution: BackofficeExecutionContext) {
  return createCodemodeTool(
    createBackofficeAgentContext({
      config: { agentName: "diagnostics", scope: execution.scope },
      runtime: ctx.runtime.services,
      readActiveTurn: async () => ({
        actors: execution.actors,
        scopeRestriction: backofficeExecutionScopeRestriction(execution),
        agent: {
          model: { provider: "test", modelId: "test", thinkingLevel: "low" },
          instructions: "",
          permissions: [...allBackofficePermissionRequirements],
        },
      }),
    }),
  );
}

test("Codemode execution retains unavailable-tool diagnostics without granting capabilities", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: allLocalObjects,
      name: "codemode failure diagnostics",
      env: { codemode: createCodemodeNodeExecutor(server) },
      vars: () => ({ projectId: "", failedRunId: "" }),
      setup: ({ given }) => [
        given.auth.user({ id: "owner" }),
        given.auth.organization({ id: "acme", ownerUserId: "owner" }),
        given.auth.user({ id: "stranger" }),
        given.auth.organization({ id: "globex", ownerUserId: "stranger" }),
      ],
      steps: ({ when, then }) => [
        when.project.create({
          owner,
          name: "Existing",
          createdByUserId: "owner",
          captureIdAs: "projectId",
        }),
        then.assert(
          "known provider calls fail explicitly and preserve diagnostics in the Pi result and run",
          async (ctx) => {
            const scope: BackofficeContextScope = {
              kind: "project",
              owner,
              projectId: ctx.vars.projectId,
            };
            const tool = executionTool(
              ctx,
              createBackofficeUserExecution({ scope, userId: "owner" }),
            );
            const result = await tool.execute(
              {
                code: 'async () => { console.info("before call"); return await projects.create({ name: "Forbidden sibling" }); }',
              },
              { taskId: "unavailable" } as never,
              BACKGROUND_CONTEXT,
            );
            const diagnostic = {
              name: "BackofficeToolUnavailableError",
              message: expect.stringContaining("TOOL_UNAVAILABLE: projects.create"),
              details: { status: 409, code: "TOOL_UNAVAILABLE" },
              metadata: { tool: "projects.create", scope: backofficeScopePathSegment(scope) },
            };
            expect(result).toMatchObject({
              isError: true,
              details: {
                runId: expect.any(String),
                errorDetails: diagnostic,
                logs: ["[info] before call"],
                toolCalls: [
                  {
                    providerName: "projects",
                    toolName: "create",
                    status: "error",
                    errorDetails: diagnostic,
                  },
                ],
              },
            });
            assert(
              result.details &&
                typeof result.details === "object" &&
                !Array.isArray(result.details),
            );
            const runId = result.details.runId;
            assert(typeof runId === "string");
            ctx.vars.failedRunId = runId;
            expect(
              await ctx.runtime.objects.codemode.for(scope).commands.getRun(runId),
            ).toMatchObject({
              status: "failed",
              error: diagnostic,
              logs: [{ channel: "info", text: "before call" }],
            });
            assert(result.output);
            const text = result.output[0];
            assert(text.type === "text");
            expect(text.text).toContain("Current scope:");
            expect(text.text).toContain('"code":"TOOL_UNAVAILABLE"');
            expect(text.text).not.toContain("projects is not defined");
          },
        ),
        then.assert("guests can catch diagnostics without changing their scope", async (ctx) => {
          const scope: BackofficeContextScope = {
            kind: "project",
            owner,
            projectId: ctx.vars.projectId,
          };
          const tool = executionTool(
            ctx,
            createBackofficeUserExecution({ scope, userId: "owner" }),
          );
          const result = await tool.execute(
            {
              code: `async () => {
            let failure;
            try { await context.current.projects.list({}); }
            catch (error) { failure = { code: error.code, status: error.status, metadata: error.metadata }; }
            return { failure, scope: await context.getCurrentScope() };
          }`,
            },
            { taskId: "recover" } as never,
            BACKGROUND_CONTEXT,
          );
          expect(result).toMatchObject({
            isError: false,
            details: {
              errorDetails: null,
              result: {
                failure: {
                  code: "TOOL_UNAVAILABLE",
                  status: 409,
                  metadata: { tool: "projects.list", scope: backofficeScopePathSegment(scope) },
                },
                scope,
              },
              toolCalls: [
                {
                  providerName: "current:projects",
                  status: "error",
                  errorDetails: { details: { code: "TOOL_UNAVAILABLE" } },
                },
              ],
            },
          });
        }),
        then.assert("an owner-scoped agent can still call the real provider", async (ctx) => {
          const tool = executionTool(
            ctx,
            createBackofficeUserExecution({ scope: owner, userId: "owner" }),
          );
          const result = await tool.execute(
            { code: "async () => await projects.list({})" },
            { taskId: "owner" } as never,
            BACKGROUND_CONTEXT,
          );
          expect(result).toMatchObject({
            isError: false,
            details: {
              errorDetails: null,
              result: { projects: [{ projectId: ctx.vars.projectId, name: "Existing" }] },
              toolCalls: [{ providerName: "projects", status: "success", errorDetails: null }],
            },
          });
        }),
        then.assert(
          "a user's project turn reaches the user's organizations, but not foreign ones",
          async (ctx) => {
            const scope: BackofficeContextScope = {
              kind: "project",
              owner,
              projectId: ctx.vars.projectId,
            };
            const tool = executionTool(
              ctx,
              createBackofficeUserExecution({ scope, userId: "owner" }),
            );
            const own = await tool.execute(
              { code: 'async () => await context.org("acme").projects.list({})' },
              { taskId: "own-org" } as never,
              BACKGROUND_CONTEXT,
            );
            expect(own).toMatchObject({
              isError: false,
              details: {
                result: { projects: [{ projectId: ctx.vars.projectId, name: "Existing" }] },
              },
            });
            const foreign = await tool.execute(
              { code: 'async () => await context.org("globex").projects.list({})' },
              { taskId: "foreign-org" } as never,
              BACKGROUND_CONTEXT,
            );
            expect(foreign).toMatchObject({
              isError: true,
              details: {
                errorDetails: {
                  message: expect.stringContaining("Permission denied for projects.list"),
                },
              },
            });
          },
        ),
        then.assert("credential restrictions still reject switching to the owner", async (ctx) => {
          const scope: BackofficeContextScope = {
            kind: "project",
            owner,
            projectId: ctx.vars.projectId,
          };
          const tool = executionTool(ctx, {
            ...createBackofficeUserExecution({ scope, userId: "owner" }),
            scopeRestriction: scope,
          });
          const result = await tool.execute(
            { code: 'async () => await context.org("acme").projects.list({})' },
            { taskId: "restricted" } as never,
            BACKGROUND_CONTEXT,
          );
          expect(result).toMatchObject({
            isError: true,
            details: {
              errorDetails: {
                message: expect.stringContaining("Credential scope does not permit"),
              },
            },
          });
        }),
        then.assert(
          "unknown tools and unrelated guest errors are not relabeled as unavailable",
          async (ctx) => {
            const scope: BackofficeContextScope = {
              kind: "project",
              owner,
              projectId: ctx.vars.projectId,
            };
            const tool = executionTool(
              ctx,
              createBackofficeUserExecution({ scope, userId: "owner" }),
            );
            const unknown = await tool.execute(
              { code: "async () => await context.current.projects.missing({})" },
              { taskId: "unknown" } as never,
              BACKGROUND_CONTEXT,
            );
            expect(unknown).toMatchObject({
              isError: true,
              details: {
                errorDetails: {
                  message: "Unknown scoped tool: projects.missing",
                  details: null,
                  metadata: null,
                },
              },
            });
            const unrelated = await tool.execute(
              {
                code: `async () => {
            try { await projects.list({}); } catch {}
            throw new TypeError("Independent guest failure");
          }`,
              },
              { taskId: "unrelated" } as never,
              BACKGROUND_CONTEXT,
            );
            expect(unrelated).toMatchObject({
              isError: true,
              details: {
                errorDetails: {
                  name: "TypeError",
                  message: "Independent guest failure",
                  details: null,
                  metadata: null,
                },
                toolCalls: [
                  { status: "error", errorDetails: { details: { code: "TOOL_UNAVAILABLE" } } },
                ],
              },
            });
          },
        ),
        then.assert(
          "failed calls never created siblings and their failure events retain diagnostics",
          async (ctx) => {
            const callRoute = createAutomationsRouteCaller({
              object: ctx.runtime.objects.automations.for(owner),
            });
            const projects = await callRoute("GET", "/projects");
            assert(projects.type === "json");
            expect(projects.data.projects.map((project) => project.projectId)).toEqual([
              ctx.vars.projectId,
            ]);
            await ctx.drain();
            const scope: BackofficeContextScope = {
              kind: "project",
              owner,
              projectId: ctx.vars.projectId,
            };
            const events = await createAutomationsRouteCaller({
              object: ctx.runtime.objects.automations.for(scope),
            })("GET", "/events", {
              query: new URLSearchParams({
                source: "codemode",
                eventType: "run.failed",
                limit: "100",
              }),
            });
            assert(events.type === "json");
            expect(events.data.events).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  payload: expect.objectContaining({
                    runId: ctx.vars.failedRunId,
                    error: expect.objectContaining({
                      details: { status: 409, code: "TOOL_UNAVAILABLE" },
                      metadata: {
                        tool: "projects.create",
                        scope: backofficeScopePathSegment(scope),
                      },
                    }),
                  }),
                }),
              ]),
            );
          },
        ),
      ],
    }),
  );
});
