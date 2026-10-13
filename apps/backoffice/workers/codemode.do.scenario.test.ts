import { afterAll, assert, beforeAll, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { fileURLToPath } from "node:url";

import { automationEventListResultSchema } from "@fragno-dev/backoffice-api/v0/events";
import { createCodemodeNodeExecutor } from "@fragno-dev/codemode/remote/codemode-node-executor";
import { createCodemodeTestServer } from "@fragno-dev/codemode/testing/codemode-test-server";
import { z } from "zod";

import {
  createBackofficeServiceExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import type { InMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { InMemoryApiObject } from "./api.do";
import { InMemoryAuthObject } from "./auth.do";
import { InMemoryAutomationsObject } from "./automations.do";
import { InMemoryCodemodeObject } from "./codemode.do";
import { InMemoryFormsObject } from "./forms.do";
import { InMemoryMcpObject } from "./mcp.do";
import { InMemoryResendObject } from "./resend.do";
import { InMemoryTelegramObject } from "./telegram.do";
import { InMemoryUploadObject } from "./upload.do";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  CODEMODE: (input) => new InMemoryCodemodeObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
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

function bash(runtime: InMemoryBackofficeRuntime, as: BackofficeExecutionContext = execution) {
  return createInteractiveBashHost({
    context: createCodemodeRouteBackedRuntimeContext({
      runtime: runtime.services,
      kernel: new BackofficeKernel(runtime.services),
      execution: as,
      billingOrganizationId: null,
    }),
  }).bash;
}

test("codemode runs are retained with their outcome until a later run expires them", async () => {
  const buildRunIds: string[] = [];
  const runIds = { report: "", failing: "" };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "codemode run history",
      objects: scenarioObjects,
      env: { codemode: { remoteExecutor: createCodemodeNodeExecutor(server) } },
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
            const built = await bash(runtime).exec(
              `js.build scripts/${name}.js --out .build/${name}.module.json --format json`,
              { cwd: "/workspace" },
            );
            assert.equal(built.exitCode, 0, built.stderr);
            buildRunIds.push(JSON.parse(built.stdout).runId);
          }
        }),
        when.time.advance("1 day"),
        then.assert("runs page newest first with outcomes and logs", async ({ runtime }) => {
          const report = await bash(runtime).exec(
            "js.run .build/report.module.json --format json",
            {
              cwd: "/workspace",
            },
          );
          assert.equal(report.exitCode, 0, report.stderr);
          runIds.report = JSON.parse(report.stdout).runId;
          const failing = await bash(runtime).exec(
            "js.run .build/failing.module.json --format json",
            {
              cwd: "/workspace",
            },
          );
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
            const listed = await bash(ctx.runtime).exec("events.list --limit 100 --format json");
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
          const report = await bash(ctx.runtime).exec(`js.logs ${runIds.report}`);
          assert.equal(report.exitCode, 0, report.stderr);
          assert.equal(report.stdout, "report ready\n");

          // Lines are stored with their channel and labelled only when read as text.
          const failing = await bash(ctx.runtime).exec(`js.logs ${runIds.failing}`);
          assert.equal(failing.exitCode, 1);
          assert.equal(failing.stdout, "[error] about to explode\n");
          expect(failing.stderr).toContain("Startup exploded");
          const failingJson = await bash(ctx.runtime).exec(
            `js.logs ${runIds.failing} --format json`,
          );
          expect(JSON.parse(failingJson.stdout).logs).toEqual([
            { at: expect.any(Number), channel: "error", text: "about to explode" },
          ]);

          const foreign = await bash(ctx.runtime, otherExecution).exec(`js.logs ${runIds.report}`);
          assert.notEqual(foreign.exitCode, 0);
          expect(foreign.stderr).toContain("CODEMODE_RUN_FORBIDDEN");
        }),
        then.assert(
          "runs keep their caller's ceiling and only callers holding that authority read their logs",
          async (ctx) => {
            const runAs = async (as: BackofficeExecutionContext) => {
              const ran = await bash(ctx.runtime, as).exec(
                "js.run .build/report.module.json --format json",
                { cwd: "/workspace" },
              );
              assert.equal(ran.exitCode, 0, ran.stderr);
              return z.object({ runId: z.string() }).parse(JSON.parse(ran.stdout)).runId;
            };
            const readAs = async (as: BackofficeExecutionContext, runId: string) => {
              const read = await bash(ctx.runtime, as).exec(`js.logs ${runId}`);
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
            const listed = await bash(ctx.runtime).exec("events.list --limit 100 --format json");
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
          const report = await bash(runtime).exec("js.run .build/report.module.json", {
            cwd: "/workspace",
          });
          assert.equal(report.exitCode, 0, report.stderr);

          const codemode = runtime.objects.codemode.forOrg("org-1").commands;
          const runs = await codemode.listRuns({ page: "first", pageSize: 20 });
          // Builds and setup writes expired; the runs from day one and the new run remain.
          expect(runs.runs.map((run) => run.activationKind)).toEqual(Array(5).fill("compiled"));
          assert.equal(await codemode.getRun(buildRunIds[1]), null);
          const expired = await bash(runtime).exec(`js.logs ${buildRunIds[1]}`);
          assert.notEqual(expired.exitCode, 0);
          expect(expired.stderr).toContain("CODEMODE_RUN_NOT_FOUND");
        }),
      ],
    }),
  );
});
