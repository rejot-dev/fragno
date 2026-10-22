import { afterAll, assert, beforeAll, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { fileURLToPath } from "node:url";

import {
  automationEventListResultSchema,
  type AutomationEvent,
} from "@fragno-dev/backoffice-api/v0/events";
import type { CodemodeExecutor } from "@fragno-dev/codemode/execution/codemode-activation-contract";
import { createCodemodeNodeExecutor } from "@fragno-dev/codemode/remote/codemode-node-executor";
import { createCodemodeTestServer } from "@fragno-dev/codemode/testing/codemode-test-server";
import { z } from "zod";

import {
  createBackofficeServiceExecution,
  createBackofficeSystemExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import type { InMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import {
  backofficeFiles,
  defineBackofficeScenario,
  runBackofficeScenario,
} from "@/fragno/automation/scenario";
import { codemodeRunnerFor } from "@/fragno/codemode/codemode-object-execute";
import { runBackofficeCodemode } from "@/fragno/codemode/execute";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import {
  createTrustedSystemBackofficeToolContext,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
} from "@/fragno/runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import { InMemoryApiObject } from "./api.do";
import { InMemoryAuthObject } from "./auth.do";
import { InMemoryAutomationsObject } from "./automations.do";
import { InMemoryBillingObject } from "./billing.do";
import { InMemoryCodemodeObject } from "./codemode.do";
import { InMemoryFormsObject } from "./forms.do";
import { InMemoryMcpObject } from "./mcp.do";
import { InMemoryOtpObject } from "./otp.do";
import { InMemoryResendObject } from "./resend.do";
import { InMemoryTelegramObject } from "./telegram.do";
import { InMemoryUploadObject } from "./upload.do";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  BILLING: (input) => new InMemoryBillingObject(input),
  CODEMODE: (input) => new InMemoryCodemodeObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  OTP: (input) => new InMemoryOtpObject(input),
  MCP: (input) => new InMemoryMcpObject(input),
  RESEND: (input) => new InMemoryResendObject(input),
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

let server: Awaited<ReturnType<typeof createCodemodeTestServer>>;
beforeAll(async () => {
  server = await createCodemodeTestServer(
    undefined,
    fileURLToPath(new URL("../", import.meta.url)),
  );
});
afterAll(async () => {
  await server?.close();
});

const execution = createBackofficeServiceExecution({
  scope: { kind: "org", orgId: "org-1" },
  service: { type: "automation", id: "codemode-history" },
});

const otherExecution = createBackofficeServiceExecution({
  scope: { kind: "org", orgId: "org-1" },
  service: { type: "automation", id: "another-automation" },
});

// A delegate narrows its principal's authority; a scope ceiling bounds where it may act.
const delegatedExecution = {
  ...execution,
  actors: {
    ...execution.actors,
    delegation: [
      { scope: "internal", type: "automation", id: "helper", role: "delegate" } as const,
    ],
  },
};
const restrictedExecution = {
  ...execution,
  scopeRestriction: { kind: "org", orgId: "org-1" } as const,
};

async function bash(
  runtime: InMemoryBackofficeRuntime,
  as: BackofficeExecutionContext = execution,
) {
  return (
    await createInteractiveBashHost({
      context: createCodemodeRouteBackedRuntimeContext({
        emitter: { kind: "caller" },
        runtime: runtime.services,
        kernel: new BackofficeKernel(runtime.services),
        execution: as,
      }),
    })
  ).bash;
}

async function executions(
  runtime: InMemoryBackofficeRuntime,
  owner: { kind: "org"; orgId: string } | { kind: "user"; userId: string },
  scope: BackofficeExecutionContext["scope"],
) {
  const page = await runtime.objects.billing.for(owner).commands.getTrackers({
    scope,
    period: new Date(runtime.now()).toISOString().slice(0, 7),
    pageSize: 100,
  });
  const tracker = page.trackers.find((tracker) => tracker.meter === "codemode.executions");
  return tracker ? { quantity: tracker.quantity, eventCount: tracker.eventCount } : null;
}

test("codemode runs are retained with their outcome until a later run expires them", async () => {
  const buildRunIds: string[] = [];
  const runIds = { report: "", failing: "" };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "codemode run history",
      objects: scenarioObjects,
      env: { codemode: createCodemodeNodeExecutor(server) },
      setup: ({ given }) => [
        given.organization.exists({ id: "org-1" }),
        given.codemode.writeFile({
          orgId: "org-1",
          path: "/workspace/scripts/report.js",
          content: 'console.log("report ready");',
        }),
        given.codemode.writeFile({
          orgId: "org-1",
          path: "/workspace/scripts/failing.js",
          content: 'console.error("about to explode");\nthrow new Error("Startup exploded");',
        }),
      ],
      steps: ({ when, then }) => [
        when.time.advance("1 hour"),
        then.assert("both scripts build", async ({ runtime }) => {
          for (const name of ["report", "failing"]) {
            const built = await (
              await bash(runtime)
            ).exec(`js.build scripts/${name}.js --out .build/${name}.module.json --format json`, {
              cwd: "/workspace",
            });
            assert.equal(built.exitCode, 0, built.stderr);
            buildRunIds.push(JSON.parse(built.stdout).runId);
          }
        }),
        when.time.advance("1 day"),
        then.assert("runs page newest first with outcomes and logs", async ({ runtime }) => {
          const report = await (
            await bash(runtime)
          ).exec("js.run .build/report.module.json --format json", {
            cwd: "/workspace",
          });
          assert.equal(report.exitCode, 0, report.stderr);
          runIds.report = JSON.parse(report.stdout).runId;
          const failing = await (
            await bash(runtime)
          ).exec("js.run .build/failing.module.json --format json", {
            cwd: "/workspace",
          });
          assert.notEqual(failing.exitCode, 0);
          runIds.failing = JSON.parse(failing.stdout).runId;

          const codemode = runtime.objects.codemode.forOrg("org-1").commands;
          const runs = await codemode.listRuns({ page: "first", pageSize: 2 });
          expect(runs.runs).toHaveLength(2);
          expect(runs.runs).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: runIds.report,
                activationKind: "compiled",
                origin: { kind: "file", path: "/workspace/.build/report.module.json" },
                actors: execution.actors,
                status: "completed",
                logs: [{ at: expect.any(Number), channel: "log", text: "report ready" }],
              }),
              expect.objectContaining({
                id: runIds.failing,
                activationKind: "compiled",
                status: "failed",
                error: expect.objectContaining({
                  message: expect.stringContaining("Startup exploded"),
                }),
              }),
            ]),
          );
          assert(runs.hasNextPage && runs.cursor !== null);

          const builds = await codemode.listRuns({ page: "next", cursor: runs.cursor });
          expect(builds.runs).toEqual(
            [...buildRunIds].reverse().map((id) =>
              expect.objectContaining({
                id,
                activationKind: "module-build",
                status: "completed",
              }),
            ),
          );
          assert(builds.hasNextPage && builds.cursor !== null);
          expect(await codemode.getRun(buildRunIds[1])).toEqual(builds.runs[0]);

          // Setup wrote both scripts through immediate codemode in the same scope.
          const writes = await codemode.listRuns({ page: "next", cursor: builds.cursor });
          expect(writes.runs).toEqual([
            expect.objectContaining({ activationKind: "immediate", status: "completed" }),
            expect.objectContaining({ activationKind: "immediate", status: "completed" }),
          ]);
          assert.equal(writes.hasNextPage, false);
        }),
        then.assert(
          "each run's start and outcome become codemode events attributed to its caller",
          async (ctx) => {
            await ctx.drain();
            const listed = await (
              await bash(ctx.runtime)
            ).exec("events.list --limit 100 --format json");
            assert.equal(listed.exitCode, 0, listed.stderr);
            const events = automationEventListResultSchema
              .parse(JSON.parse(listed.stdout))
              .events.filter((event) => event.source === "codemode");
            const runs = await ctx.runtime.objects.codemode
              .forOrg("org-1")
              .commands.listRuns({ page: "first", pageSize: 20 });
            expect(runs.runs).toHaveLength(6);
            for (const run of runs.runs) {
              const forRun = events.filter((event) => event.subject?.runId === run.id);
              expect(forRun.map((event) => event.eventType).sort()).toEqual([
                run.status === "failed" ? "run.failed" : "run.completed",
                "run.started",
              ]);
            }

            const fileEvents = events.filter(
              (event) => event.eventType !== "run.started" && event.actors.principal !== null,
            );
            expect(fileEvents).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  eventType: "run.completed",
                  scope: { kind: "org", orgId: "org-1" },
                  actors: execution.actors,
                  payload: expect.objectContaining({
                    activationKind: "module-build",
                    origin: { kind: "file", path: "/workspace/scripts/report.js" },
                  }),
                }),
                expect.objectContaining({
                  eventType: "run.completed",
                  actors: execution.actors,
                  subject: { orgId: "org-1", runId: runIds.report },
                  payload: expect.objectContaining({
                    activationKind: "compiled",
                    origin: { kind: "file", path: "/workspace/.build/report.module.json" },
                  }),
                }),
                expect.objectContaining({
                  eventType: "run.failed",
                  actors: execution.actors,
                  subject: { orgId: "org-1", runId: runIds.failing },
                  payload: expect.objectContaining({
                    activationKind: "compiled",
                    origin: { kind: "file", path: "/workspace/.build/failing.module.json" },
                    error: expect.objectContaining({
                      message: expect.stringContaining("Startup exploded"),
                    }),
                  }),
                }),
              ]),
            );
            for (const event of events.filter((event) => event.eventType !== "run.started")) {
              expect(event.payload).not.toHaveProperty("logs");
              expect(Date.parse(String(event.payload.finishedAt))).toBeGreaterThanOrEqual(
                Date.parse(String(event.payload.startedAt)),
              );
            }
          },
        ),
        then.assert("js.run's run ID leads its principal to the run's logs", async (ctx) => {
          const report = await (await bash(ctx.runtime)).exec(`js.logs ${runIds.report}`);
          assert.equal(report.exitCode, 0, report.stderr);
          assert.equal(report.stdout, "report ready\n");

          // Lines are stored with their channel and labelled only when read as text.
          const failing = await (await bash(ctx.runtime)).exec(`js.logs ${runIds.failing}`);
          assert.equal(failing.exitCode, 1);
          assert.equal(failing.stdout, "[error] about to explode\n");
          expect(failing.stderr).toContain("Startup exploded");
          const failingJson = await (
            await bash(ctx.runtime)
          ).exec(`js.logs ${runIds.failing} --format json`);
          expect(JSON.parse(failingJson.stdout).logs).toEqual([
            { at: expect.any(Number), channel: "error", text: "about to explode" },
          ]);

          const foreign = await (
            await bash(ctx.runtime, otherExecution)
          ).exec(`js.logs ${runIds.report}`);
          assert.notEqual(foreign.exitCode, 0);
          expect(foreign.stderr).toContain("CODEMODE_RUN_FORBIDDEN");
        }),
        then.assert(
          "runs keep their caller's ceiling and only callers holding that authority read their logs",
          async (ctx) => {
            const runAs = async (as: BackofficeExecutionContext) => {
              const ran = await (
                await bash(ctx.runtime, as)
              ).exec("js.run .build/report.module.json --format json", { cwd: "/workspace" });
              assert.equal(ran.exitCode, 0, ran.stderr);
              return z.object({ runId: z.string() }).parse(JSON.parse(ran.stdout)).runId;
            };
            const readAs = async (as: BackofficeExecutionContext, runId: string) => {
              const read = await (await bash(ctx.runtime, as)).exec(`js.logs ${runId}`);
              if (read.exitCode === 0) {
                return "allowed";
              }
              return read.stderr.includes("CODEMODE_RUN_FORBIDDEN") ? "forbidden" : read.stderr;
            };
            const delegatedRun = await runAs(delegatedExecution);
            const restrictedRun = await runAs(restrictedExecution);

            expect({
              delegateOwnRun: await readAs(delegatedExecution, delegatedRun),
              delegatePrincipalRun: await readAs(delegatedExecution, runIds.report),
              principalDelegateRun: await readAs(execution, delegatedRun),
              restrictedOwnRun: await readAs(restrictedExecution, restrictedRun),
              restrictedUnrestrictedRun: await readAs(restrictedExecution, runIds.report),
              unrestrictedRestrictedRun: await readAs(execution, restrictedRun),
            }).toEqual({
              delegateOwnRun: "allowed",
              delegatePrincipalRun: "forbidden",
              principalDelegateRun: "allowed",
              restrictedOwnRun: "allowed",
              restrictedUnrestrictedRun: "forbidden",
              unrestrictedRestrictedRun: "allowed",
            });

            await ctx.drain();
            const listed = await (
              await bash(ctx.runtime)
            ).exec("events.list --limit 100 --format json");
            const ceilings = automationEventListResultSchema
              .parse(JSON.parse(listed.stdout))
              .events.filter(
                (event) =>
                  event.subject?.runId === restrictedRun || event.subject?.runId === runIds.report,
              )
              .map((event) => [event.subject?.runId, event.eventType, event.scopeRestriction]);
            expect(ceilings).toEqual(
              expect.arrayContaining([
                [restrictedRun, "run.started", restrictedExecution.scopeRestriction],
                [restrictedRun, "run.completed", restrictedExecution.scopeRestriction],
                [runIds.report, "run.completed", null],
              ]),
            );
          },
        ),
        when.time.advance("6.5 days"),
        then.assert("a new run removes only runs past retention", async ({ runtime }) => {
          const report = await (
            await bash(runtime)
          ).exec("js.run .build/report.module.json", {
            cwd: "/workspace",
          });
          assert.equal(report.exitCode, 0, report.stderr);

          const codemode = runtime.objects.codemode.forOrg("org-1").commands;
          const runs = await codemode.listRuns({ page: "first", pageSize: 20 });
          // Builds and setup writes expired; the runs from day one and the new run remain.
          expect(runs.runs.map((run) => run.activationKind)).toEqual(Array(5).fill("compiled"));
          assert.equal(await codemode.getRun(buildRunIds[1]), null);
          const expired = await (await bash(runtime)).exec(`js.logs ${buildRunIds[1]}`);
          assert.notEqual(expired.exitCode, 0);
          expect(expired.stderr).toContain("CODEMODE_RUN_NOT_FOUND");
        }),
      ],
    }),
  );
});

test("codemode guests are attributed to their scope owner and builds remain unmetered", async () => {
  const userScope = { kind: "user", userId: "user-1" } as const;

  async function runInScope(
    runtime: InMemoryBackofficeRuntime,
    scope: BackofficeExecutionContext["scope"],
  ) {
    const scopedExecution = createBackofficeSystemExecution(scope);
    const result = await runBackofficeCodemode({
      code: "async () => 1",
      codemode: codemodeRunnerFor(runtime.objects.codemode.for(scope).commands, scopedExecution),
      families: runtimeToolFamilies,
      toolContext: createBackofficeToolContext(
        createCodemodeRouteBackedRuntimeContext({
          emitter: { kind: "caller" },
          runtime: runtime.services,
          kernel: new BackofficeKernel(runtime.services),
          execution: scopedExecution,
        }),
      ),
    });
    assert.equal(result.error, undefined);
  }

  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "codemode run billing",
      objects: scenarioObjects,
      env: { codemode: createCodemodeNodeExecutor(server) },
      setup: ({ given }) => [
        given.organization.exists({ id: "org-1" }),
        given.organization.exists({ id: "org-2" }),
        given.codemode.writeFile({
          orgId: "org-1",
          path: "/workspace/scripts/report.js",
          content: 'console.log("report ready");',
        }),
      ],
      steps: ({ then }) => [
        then.assert("an organization owns usage in its scope", async (ctx) => {
          const orgBash = await bash(ctx.runtime, execution);
          const built = await orgBash.exec(
            "js.build scripts/report.js --out .build/report.module.json",
            { cwd: "/workspace" },
          );
          assert.equal(built.exitCode, 0, built.stderr);
          for (let run = 0; run < 2; run++) {
            const ran = await orgBash.exec("js.run .build/report.module.json", {
              cwd: "/workspace",
            });
            assert.equal(ran.exitCode, 0, ran.stderr);
          }
          await ctx.drain();

          // The setup write and both runs loaded a guest; the build only compiled.
          expect(
            await executions(ctx.runtime, { kind: "org", orgId: "org-1" }, execution.scope),
          ).toEqual({
            quantity: "3",
            eventCount: "3",
          });
          expect(
            await executions(ctx.runtime, { kind: "org", orgId: "org-2" }, execution.scope),
          ).toBeNull();
        }),
        then.assert("a user owns every run in their personal scope", async (ctx) => {
          await runInScope(ctx.runtime, userScope);
          await runInScope(ctx.runtime, userScope);
          await ctx.drain();

          expect(await executions(ctx.runtime, userScope, userScope)).toEqual({
            quantity: "2",
            eventCount: "2",
          });
          expect(
            await executions(ctx.runtime, { kind: "org", orgId: "org-1" }, userScope),
          ).toBeNull();
          const runs = await ctx.runtime.objects.codemode
            .for(userScope)
            .commands.listRuns({ page: "first", pageSize: 20 });
          expect(runs.runs).toHaveLength(2);
        }),
        then.assert("app and project usage follows the root owner", async (ctx) => {
          for (const owner of [userScope, { kind: "org", orgId: "org-1" } as const]) {
            const app = { kind: "app", owner, appId: "books" } as const;
            for (const scope of [
              app,
              { kind: "project", owner: app, projectId: "books-1" } as const,
            ]) {
              await runInScope(ctx.runtime, scope);
              await ctx.drain();
              expect(await executions(ctx.runtime, owner, scope)).toEqual({
                quantity: "1",
                eventCount: "1",
              });
              expect(
                await executions(ctx.runtime, { kind: "org", orgId: "org-2" }, scope),
              ).toBeNull();
            }
          }
        }),
      ],
    }),
  );
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "missing billing refuses customer codemode without disabling system work",
      objects: { ...scenarioObjects, BILLING: null },
      env: { codemode: createCodemodeNodeExecutor(server) },
      steps: ({ then }) => [
        then.assert("a customer cannot start a guest without Billing", async ({ runtime }) => {
          await expect(runInScope(runtime, userScope)).rejects.toThrow("BILLING_UNAVAILABLE");
        }),
        then.assert("system work has an explicit non-customer attribution", async ({ runtime }) => {
          await runInScope(runtime, { kind: "system" });
          await runtime.drain();
        }),
      ],
    }),
  );
});

test("each workflow tick is a billed run that publishes no run events", async () => {
  const path = "/workspace/automations/cool-down.workflow.js";
  const started: AutomationEvent = {
    id: "cool-down-started",
    scopeRestriction: null,
    scope: execution.scope,
    source: "custom",
    eventType: "cool-down.requested",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: {},
    actors: execution.actors,
    subject: { orgId: "org-1" },
    causation: { kind: "origin" },
  };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "a workflow that sleeps once runs twice",
      objects: scenarioObjects,
      env: { codemode: createCodemodeNodeExecutor(server) },
      files: backofficeFiles.custom({
        workspace: {
          "automations/cool-down.workflow.js": `export default defineWorkflow({ name: "cool-down" }, async (_event, step) => {
  console.log("cooling down");
  await step.sleep("cool down", "5 seconds");
  console.log("cooled down");
  return "done";
});`,
        },
      }),
      setup: ({ given }) => [given.organization.exists({ id: "org-1" })],
      steps: ({ when, then }) => [
        when.workflow.createInstance({
          orgId: "org-1",
          instanceId: "cool-down-1",
          execution,
          path,
          event: started,
        }),
        when.time.advance("10 seconds"),
        then.assert("the sleep's tick is suspended and the resumed tick completes", async (ctx) => {
          await ctx.drain();
          const codemode = ctx.runtime.objects.codemode.forOrg("org-1").commands;
          const { runs } = await codemode.listRuns({ page: "first", pageSize: 20 });
          expect(runs).toEqual([
            expect.objectContaining({
              activationKind: "workflow",
              workflowInstanceId: "cool-down-1",
              origin: { kind: "file", path },
              actors: execution.actors,
              status: "completed",
              logs: [
                { at: expect.any(Number), channel: "log", text: "cooling down" },
                { at: expect.any(Number), channel: "log", text: "cooled down" },
              ],
            }),
            expect.objectContaining({
              activationKind: "workflow",
              workflowInstanceId: "cool-down-1",
              status: "suspended",
              reason: expect.objectContaining({ type: "sleep", stepKey: "sleep:cool down" }),
              logs: [{ at: expect.any(Number), channel: "log", text: "cooling down" }],
            }),
          ]);

          const logs = await (await bash(ctx.runtime)).exec(`js.logs ${runs[1].id} --format json`);
          assert.equal(logs.exitCode, 0, logs.stderr);
          expect(JSON.parse(logs.stdout)).toMatchObject({ runId: runs[1].id, status: "suspended" });

          expect(
            await executions(ctx.runtime, { kind: "org", orgId: "org-1" }, execution.scope),
          ).toEqual({
            quantity: "2",
            eventCount: "2",
          });

          // Ticks are internal to their workflow; a run event could start the workflow again.
          const listed = await (
            await bash(ctx.runtime)
          ).exec("events.list --limit 100 --format json");
          assert.equal(listed.exitCode, 0, listed.stderr);
          expect(
            automationEventListResultSchema
              .parse(JSON.parse(listed.stdout))
              .events.filter((event) => event.source === "codemode"),
          ).toEqual([]);
        }),
      ],
    }),
  );
});

test("a scope's eleventh concurrent run waits for its turn instead of failing", async () => {
  let entered = 0;
  let active = 0;
  let maxActive = 0;
  let openGate = () => {};
  const gateOpened = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const gate = defineBackofficeRuntimeToolFamily({
    namespace: "gate",
    tools: [
      defineBackofficeRuntimeTool({
        id: "gate.wait",
        namespace: "gate",
        name: "wait",
        description: "Wait until the test opens the gate.",
        requiredPermissions: [],
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        execute: async () => {
          entered += 1;
          active += 1;
          maxActive = Math.max(maxActive, active);
          await gateOpened;
          active -= 1;
          return {};
        },
      }),
    ],
  });

  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "codemode guest slots",
      objects: scenarioObjects,
      env: { codemode: createCodemodeNodeExecutor(server) },
      setup: ({ given }) => [given.organization.exists({ id: "org-1" })],
      steps: ({ then }) => [
        then.assert("ten guests run while the eleventh run waits", async (ctx) => {
          const object = ctx.runtime.objects.codemode.forOrg("org-1").commands;
          const codemode = codemodeRunnerFor(object, execution);
          const run = () =>
            runBackofficeCodemode({
              code: "async () => await gate.wait({})",
              codemode,
              families: [gate],
              toolContext: createTrustedSystemBackofficeToolContext({ runtimes: {} }),
            });
          const runs = Array.from({ length: 11 }, run);
          try {
            await vi.waitFor(() => expect(entered).toBe(10), { timeout: 10_000 });
            await vi.waitFor(
              async () => {
                const page = await object.listRuns({ page: "first", pageSize: 20 });
                expect(page.runs.map((run) => run.status)).toEqual(Array(11).fill("running"));
              },
              { timeout: 5_000 },
            );
            // Without the limit, the eleventh guest would reach the gate well within this window.
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(entered).toBe(10);
          } finally {
            // A failed assertion must not leave the admitted guests blocked during cleanup.
            openGate();
          }
          const results = await Promise.all(runs);
          expect(results.map((result) => result.error)).toEqual(Array(11).fill(undefined));
          expect({ entered, maxActive }).toEqual({ entered: 11, maxActive: 10 });
        }),
      ],
    }),
  );
}, 30_000);

test("a workflow tick that loses the bridge runs again instead of erroring its workflow", async () => {
  const bridge = createCodemodeNodeExecutor(server);
  let lostTicks = 0;
  const restartingBridge: CodemodeExecutor = async (activation, host) => {
    if (activation.kind === "workflow" && lostTicks === 0) {
      lostTicks += 1;
      return { status: "interrupted", cause: "bridge restarted" };
    }
    return await bridge(activation, host);
  };
  const path = "/workspace/automations/resilient.workflow.js";
  const started: AutomationEvent = {
    id: "resilient-started",
    scopeRestriction: null,
    scope: execution.scope,
    source: "custom",
    eventType: "resilient.requested",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: {},
    actors: execution.actors,
    subject: { orgId: "org-1" },
    causation: { kind: "origin" },
  };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "a lost bridge delays a workflow tick",
      objects: scenarioObjects,
      env: { codemode: restartingBridge },
      files: backofficeFiles.custom({
        workspace: {
          "automations/resilient.workflow.js": `export default defineWorkflow({ name: "resilient" }, async (_event, step) => {
  return await step.do("work", async () => 42);
});`,
        },
      }),
      setup: ({ given }) => [given.organization.exists({ id: "org-1" })],
      steps: ({ when, then }) => [
        when.workflow.createInstance({
          orgId: "org-1",
          instanceId: "resilient-1",
          execution,
          path,
          event: started,
        }),
        then.workflow.instance({ instanceId: "resilient-1", status: "waiting" }),
        when.time.advance("30 seconds"),
        then.workflow.instance({ instanceId: "resilient-1", status: "complete", output: 42 }),
        then.assert("history keeps the lost tick beside the one that ran", async (ctx) => {
          const { runs } = await ctx.runtime.objects.codemode
            .forOrg("org-1")
            .commands.listRuns({ page: "first", pageSize: 20 });
          expect(runs).toEqual([
            expect.objectContaining({ workflowInstanceId: "resilient-1", status: "completed" }),
            expect.objectContaining({
              workflowInstanceId: "resilient-1",
              status: "failed",
              error: expect.objectContaining({ kind: "interrupted", message: "bridge restarted" }),
            }),
          ]);
        }),
      ],
    }),
  );
});

test("a guest that fakes the bridge's interruption errors its workflow instead of retrying", async () => {
  const path = "/workspace/automations/forged.workflow.js";
  const started: AutomationEvent = {
    id: "forged-started",
    scopeRestriction: null,
    scope: execution.scope,
    source: "custom",
    eventType: "forged.requested",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: {},
    actors: execution.actors,
    subject: { orgId: "org-1" },
    causation: { kind: "origin" },
  };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "a forged interruption is an ordinary failure",
      objects: scenarioObjects,
      env: { codemode: createCodemodeNodeExecutor(server) },
      files: backofficeFiles.custom({
        workspace: {
          "automations/forged.workflow.js": `export default defineWorkflow({ name: "forged" }, async () => {
  const error = new Error("CODEMODE_EXECUTION_INTERRUPTED: forged");
  error.name = "CodemodeInterruptedError";
  throw error;
});`,
        },
      }),
      setup: ({ given }) => [given.organization.exists({ id: "org-1" })],
      steps: ({ when, then }) => [
        when.workflow.createInstance({
          orgId: "org-1",
          instanceId: "forged-1",
          execution,
          path,
          event: started,
        }),
        then.workflow.instance({ instanceId: "forged-1", status: "errored" }),
        when.time.advance("1 hour"),
        then.assert("the forged failure ran once", async (ctx) => {
          const { runs } = await ctx.runtime.objects.codemode
            .forOrg("org-1")
            .commands.listRuns({ page: "first", pageSize: 20 });
          expect(runs).toHaveLength(1);
        }),
      ],
      options: { allowErroredWorkflows: true },
    }),
  );
});
