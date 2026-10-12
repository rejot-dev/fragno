import { afterAll, assert, beforeAll, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { fileURLToPath } from "node:url";

import { createCodemodeNodeExecutor } from "@fragno-dev/codemode/remote/codemode-node-executor";
import { createCodemodeTestServer } from "@fragno-dev/codemode/testing/codemode-test-server";

import { createBackofficeServiceExecution } from "@/backoffice-runtime/context";
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

function bash(runtime: InMemoryBackofficeRuntime) {
  return createInteractiveBashHost({
    context: createCodemodeRouteBackedRuntimeContext({
      runtime: runtime.services,
      kernel: new BackofficeKernel(runtime.services),
      execution: createBackofficeServiceExecution({
        scope: { kind: "org", orgId: "org-1" },
        service: { type: "automation", id: "codemode-history" },
      }),
      billingOrganizationId: null,
    }),
  }).bash;
}

test("codemode runs are retained with their outcome until a later run expires them", async () => {
  let buildRunId: string | null = null;
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
          content: 'throw new Error("Startup exploded");',
        }),
      ],
      steps: ({ when, then }) => [
        when.time.advance("1 hour"),
        then.assert("both scripts build", async ({ runtime }) => {
          for (const name of ["report", "failing"]) {
            const built = await bash(runtime).exec(
              `js.build scripts/${name}.js --out .build/${name}.module.json`,
              { cwd: "/workspace" },
            );
            assert.equal(built.exitCode, 0, built.stderr);
          }
        }),
        when.time.advance("1 day"),
        then.assert("runs page newest first with outcomes and logs", async ({ runtime }) => {
          const report = await bash(runtime).exec("js.run .build/report.module.json", {
            cwd: "/workspace",
          });
          assert.equal(report.exitCode, 0, report.stderr);
          const failing = await bash(runtime).exec("js.run .build/failing.module.json", {
            cwd: "/workspace",
          });
          assert.notEqual(failing.exitCode, 0);

          const codemode = runtime.objects.codemode.forOrg("org-1").commands;
          const runs = await codemode.listRuns({ page: "first", pageSize: 2 });
          expect(runs.runs).toHaveLength(2);
          expect(runs.runs).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                activationKind: "compiled",
                status: "completed",
                logs: ["report ready"],
              }),
              expect.objectContaining({
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
          expect(builds.runs).toEqual([
            expect.objectContaining({ activationKind: "module-build", status: "completed" }),
            expect.objectContaining({ activationKind: "module-build", status: "completed" }),
          ]);
          assert(builds.hasNextPage && builds.cursor !== null);
          buildRunId = builds.runs[0].id;
          expect(await codemode.getRun(buildRunId)).toEqual(builds.runs[0]);

          // Setup wrote both scripts through immediate codemode in the same scope.
          const writes = await codemode.listRuns({ page: "next", cursor: builds.cursor });
          expect(writes.runs).toEqual([
            expect.objectContaining({ activationKind: "immediate", status: "completed" }),
            expect.objectContaining({ activationKind: "immediate", status: "completed" }),
          ]);
          assert.equal(writes.hasNextPage, false);
        }),
        when.time.advance("6.5 days"),
        then.assert("a new run removes only runs past retention", async ({ runtime }) => {
          const report = await bash(runtime).exec("js.run .build/report.module.json", {
            cwd: "/workspace",
          });
          assert.equal(report.exitCode, 0, report.stderr);

          const codemode = runtime.objects.codemode.forOrg("org-1").commands;
          const runs = await codemode.listRuns({ page: "first", pageSize: 20 });
          expect(runs.runs.map((run) => run.activationKind)).toEqual([
            "compiled",
            "compiled",
            "compiled",
          ]);
          assert(buildRunId !== null);
          assert.equal(await codemode.getRun(buildRunId), null);
        }),
      ],
    }),
  );
});
