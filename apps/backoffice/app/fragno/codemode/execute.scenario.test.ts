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

const owner = { kind: "org", orgId: "acme", jurisdiction: null } as const;

/** The tool API a call gets in tests: its task, and somewhere for its live details to go. */
function toolApi(taskId: string) {
  return { taskId, details: async () => {} } as never;
}

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
              toolApi("unavailable"),
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
                calls: {
                  items: [
                    {
                      subject: { kind: "call", name: "projects.create", scope: null },
                      status: "failed",
                      error: expect.stringContaining("TOOL_UNAVAILABLE: projects.create"),
                    },
                  ],
                  omitted: 0,
                },
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
            toolApi("recover"),
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
              calls: {
                items: [
                  {
                    subject: { kind: "call", name: "projects.list", scope: null },
                    status: "failed",
                    error: expect.stringContaining("TOOL_UNAVAILABLE"),
                  },
                ],
              },
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
            toolApi("owner"),
            BACKGROUND_CONTEXT,
          );
          expect(result).toMatchObject({
            isError: false,
            details: {
              errorDetails: null,
              result: { projects: [{ projectId: ctx.vars.projectId, name: "Existing" }] },
              calls: {
                items: [{ subject: { kind: "call", name: "projects.list" }, status: "succeeded" }],
              },
            },
          });
        }),
        then.assert("discovery calls read as the files and skills they looked at", async (ctx) => {
          const tool = executionTool(
            ctx,
            createBackofficeUserExecution({ scope: owner, userId: "owner" }),
          );
          const skillPath = "/workspace/discovery/skills/reminders/SKILL.md";
          const result = await tool.execute(
            {
              code: `async () => {
                await state.writeFile({ path: ${JSON.stringify(skillPath)}, content: "---\\nname: reminders\\ndescription: Sends reminders.\\n---\\n# Reminders" });
                await state.glob({ pattern: "/workspace/discovery/**/SKILL.md" });
                await state.readFile({ path: ${JSON.stringify(skillPath)} });
                await state.readFile({ path: "/workspace/discovery/missing.md" }).catch(() => null);
                await state.searchFiles({ pattern: "/workspace/discovery/**", keywords: ["Reminders"] });
              }`,
            },
            toolApi("discovery"),
            BACKGROUND_CONTEXT,
          );
          expect(result).toMatchObject({
            isError: false,
            details: {
              calls: {
                items: [
                  { subject: { kind: "call", name: "state.writeFile" }, status: "succeeded" },
                  {
                    subject: { kind: "list", pattern: "/workspace/discovery/**/SKILL.md" },
                    status: "succeeded",
                  },
                  { subject: { kind: "skill", name: "reminders" }, status: "succeeded" },
                  {
                    subject: { kind: "read", path: "/workspace/discovery/missing.md" },
                    status: "failed",
                  },
                  {
                    subject: {
                      kind: "search",
                      pattern: "/workspace/discovery/**",
                      keywords: ["Reminders"],
                    },
                    status: "succeeded",
                  },
                ],
                omitted: 0,
              },
            },
          });
        }),
        then.assert(
          "a log flood past the run record budget is saved whole for the agent while its run keeps a bounded record",
          async (ctx) => {
            const tool = executionTool(
              ctx,
              createBackofficeUserExecution({ scope: owner, userId: "owner" }),
            );
            const flood = await tool.execute(
              {
                code: 'async () => { for (let i = 0; i < 6000; i++) console.log("line " + i + " " + "x".repeat(200)); return "flooded"; }',
              },
              toolApi("flood"),
              BACKGROUND_CONTEXT,
            );
            const fullOutputPath = "/workspace/.pi/diagnostics/outputs/flood.txt";
            expect(flood).toMatchObject({ isError: false, details: { fullOutputPath } });
            assert(flood.details && typeof flood.details === "object" && "runId" in flood.details);
            const run = await ctx.runtime.objects.codemode
              .for(owner)
              .commands.getRun(String(flood.details.runId));
            assert(run?.status === "completed");
            expect(run.logs.at(-1)).toMatchObject({ channel: "codemode", text: "Logs truncated." });
            expect(new TextEncoder().encode(JSON.stringify(run.logs)).byteLength).toBeLessThan(
              1.1 * 1024 * 1024,
            );

            const read = await tool.execute(
              {
                code: `async () => {
                  const lines = (await state.readFile({ path: ${JSON.stringify(fullOutputPath)} })).split("\\n");
                  return [lines.length, lines.at(-2).slice(0, 10), lines.at(-1)];
                }`,
              },
              toolApi("read-flood"),
              BACKGROUND_CONTEXT,
            );
            expect(read).toMatchObject({
              isError: false,
              details: { result: [6001, "line 5999 ", "flooded"] },
            });
          },
        ),
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
              toolApi("own-org"),
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
              toolApi("foreign-org"),
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
            toolApi("restricted"),
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
              toolApi("unknown"),
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
              toolApi("unrelated"),
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
                calls: {
                  items: [{ status: "failed", error: expect.stringContaining("TOOL_UNAVAILABLE") }],
                },
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
