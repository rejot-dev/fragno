import { afterAll, afterEach, beforeAll, assert, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { fileURLToPath } from "node:url";

import { createCodemodeNodeExecutor } from "@fragno-dev/codemode/remote/codemode-node-executor";
import { createCodemodeTestServer } from "@fragno-dev/codemode/testing/codemode-test-server";

import {
  createBackofficeServiceExecution,
  createBackofficeUserExecution,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";
import { javaScriptModuleArtifactSchema } from "@/fragno/codemode/javascript-module-artifact";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { executeBackofficeRuntimeTool } from "@/fragno/runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";

import { javaScriptRunToolFamily } from "./javascript";

let server: Awaited<ReturnType<typeof createCodemodeTestServer>>;
const compiler = { available: true, compilations: 0 };
beforeAll(async () => {
  server = await createCodemodeTestServer(
    (compile) => async (input) => {
      compiler.compilations++;
      if (!compiler.available) {
        throw new Error("Run must not compile an artifact");
      }
      return await compile(input);
    },
    fileURLToPath(new URL("../../../../", import.meta.url)),
  );
});
afterEach(() => {
  compiler.available = true;
});
afterAll(async () => {
  await server?.close();
});

const scope = { kind: "org", orgId: "org-1" } as const;
const artifactPath = "/workspace/.build/example.module.json";

test("js.run executes bundled top-level statements and dependencies with the compiler offline, ignoring exports", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "public module artifact execution",
      env: { codemode: { remoteExecutor: createCodemodeNodeExecutor(server) } },
      setup: ({ given }) => [
        given.organization.exists({ id: "org-1" }),
        given.codemode.writeFile({
          orgId: "org-1",
          path: "/workspace/scripts/example.js",
          content: `let calls = 0; console.log("main startup", calls++); export default () => { throw new Error("Default export must not run"); }; export const named = () => { throw new Error("Named export must not run"); };`,
        }),
      ],
      steps: ({ then }) => [
        then.assert(
          "Bash and codemode execute the captured bundle, not source",
          async ({ runtime }) => {
            const context = createCodemodeRouteBackedRuntimeContext({
              runtime: runtime.services,
              kernel: new BackofficeKernel(runtime.services),
              execution: createBackofficeServiceExecution({
                scope,
                service: { type: "automation", id: "artifact-runner" },
              }),
              billingOrganizationId: null,
            });
            const { bash } = createInteractiveBashHost({ context });
            const built = await bash.exec(
              `js.build scripts/example.js --out .build/example.module.json`,
              { cwd: "/workspace" },
            );
            assert.equal(built.exitCode, 0, built.stderr);
            const artifact = javaScriptModuleArtifactSchema.parse(
              await context.stateBackend.readJson(artifactPath),
            );
            await context.stateBackend.writeFile(
              artifactPath,
              JSON.stringify({
                ...artifact,
                bundle: {
                  ...artifact.bundle,
                  modules: {
                    ...artifact.bundle.modules,
                    [artifact.bundle.mainModule]:
                      `import "./dependency.js";\n${artifact.bundle.modules[artifact.bundle.mainModule]}`,
                    "dependency.js": 'console.log("dependency startup");',
                  },
                },
              }),
            );
            await context.stateBackend.rm("/workspace/scripts/example.js");
            const before = compiler.compilations;
            compiler.available = false;
            const result = await bash.exec("js.run .build/example.module.json --format json", {
              cwd: "/workspace",
            });
            assert.equal(result.exitCode, 0, result.stderr);
            const parsed = JSON.parse(result.stdout);
            expect(parsed).toMatchObject({
              status: "success",
              path: artifactPath,
              logs: ["dependency startup", "main startup 0"],
            });
            const repeated = await executeBackofficeRuntimeTool(
              javaScriptRunToolFamily.tools[0],
              { path: artifactPath },
              createBackofficeToolContext(context),
            );
            expect(repeated).toEqual(parsed);
            assert.equal(compiler.compilations, before);
            const deniedContext = createCodemodeRouteBackedRuntimeContext({
              runtime: runtime.services,
              kernel: new BackofficeKernel(runtime.services),
              execution: createBackofficeUserExecution({ scope, userId: "outsider" }),
              billingOrganizationId: null,
            });
            const denied = await createInteractiveBashHost({ context: deniedContext }).bash.exec(
              `js.run ${artifactPath}`,
            );
            assert.notEqual(denied.exitCode, 0);
          },
        ),
      ],
    }),
  );
});

for (const invalid of [
  {
    name: "startup exception",
    source: 'throw new Error("Startup exploded"); export default () => 42;',
    error: "Startup exploded",
  },
  {
    name: "global async I/O",
    source: 'await fetch("https://example.com"); export default () => 42;',
    error: "global scope",
  },
]) {
  test(`js.run returns ${invalid.name} as an error without fallback compilation`, async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: invalid.name,
        env: { codemode: { remoteExecutor: createCodemodeNodeExecutor(server) } },
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1" }),
          given.codemode.writeFile({
            orgId: "org-1",
            path: "/workspace/scripts/invalid.js",
            content: invalid.source,
          }),
        ],
        steps: ({ then }) => [
          then.assert("startup failure is returned by the CLI", async ({ runtime }) => {
            const context = createCodemodeRouteBackedRuntimeContext({
              runtime: runtime.services,
              kernel: new BackofficeKernel(runtime.services),
              execution: createBackofficeServiceExecution({
                scope,
                service: { type: "automation", id: "artifact-runner" },
              }),
              billingOrganizationId: null,
            });
            const { bash } = createInteractiveBashHost({ context });
            assert.equal(
              (await bash.exec(`js.build /workspace/scripts/invalid.js --out ${artifactPath}`))
                .exitCode,
              0,
            );
            const before = compiler.compilations;
            compiler.available = false;
            const failed = await bash.exec(`js.run ${artifactPath} --format json`);
            assert.notEqual(failed.exitCode, 0);
            expect(JSON.parse(failed.stdout)).toMatchObject({
              status: "error",
              path: artifactPath,
              error: expect.stringContaining(invalid.error),
            });
            assert.equal(compiler.compilations, before);
          }),
        ],
      }),
    );
  });
}

test("js.run validates artifact format, entrypoint, runtime, JSON and scope before execution", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "artifact execution boundary",
      env: { codemode: { remoteExecutor: createCodemodeNodeExecutor(server) } },
      setup: ({ given }) => [
        given.organization.exists({ id: "org-1" }),
        given.organization.exists({ id: "org-2" }),
        given.codemode.writeFile({
          orgId: "org-1",
          path: "/workspace/scripts/example.js",
          content: 'console.log("Valid startup");',
        }),
      ],
      steps: ({ then }) => [
        then.assert(
          "bad artifacts are rejected without running their code",
          async ({ runtime }) => {
            const context = createCodemodeRouteBackedRuntimeContext({
              runtime: runtime.services,
              kernel: new BackofficeKernel(runtime.services),
              execution: createBackofficeServiceExecution({
                scope,
                service: { type: "automation", id: "artifact-runner" },
              }),
              billingOrganizationId: null,
            });
            const { bash } = createInteractiveBashHost({ context });
            assert.equal(
              (await bash.exec(`js.build /workspace/scripts/example.js --out ${artifactPath}`))
                .exitCode,
              0,
            );
            const artifact = javaScriptModuleArtifactSchema.parse(
              await context.stateBackend.readJson(artifactPath),
            );
            const before = compiler.compilations;
            compiler.available = false;
            for (const content of [
              "{",
              JSON.stringify({ format: "unknown", bundle: artifact.bundle }),
              JSON.stringify({
                ...artifact,
                bundle: { ...artifact.bundle, mainModule: "missing.js" },
              }),
              JSON.stringify({
                ...artifact,
                bundle: {
                  ...artifact.bundle,
                  runtime: { compatibilityDate: "2026-05-07", compatibilityFlags: ["unsafe"] },
                },
              }),
            ]) {
              await context.stateBackend.writeFile(artifactPath, content);
              const failed = await bash.exec(`js.run ${artifactPath} --format json`);
              assert.notEqual(failed.exitCode, 0);
              expect(JSON.parse(failed.stdout)).toMatchObject({
                status: "error",
                path: artifactPath,
                logs: [],
              });
            }
            const other = createCodemodeRouteBackedRuntimeContext({
              runtime: runtime.services,
              kernel: new BackofficeKernel(runtime.services),
              execution: createBackofficeServiceExecution({
                scope: { kind: "org", orgId: "org-2" },
                service: { type: "automation", id: "artifact-runner" },
              }),
              billingOrganizationId: null,
            });
            const missing = await createInteractiveBashHost({ context: other }).bash.exec(
              `js.run ${artifactPath} --format json`,
            );
            assert.notEqual(missing.exitCode, 0);
            expect(missing.stdout).toContain("JAVASCRIPT_RUN_ARTIFACT_MISSING");
            assert.equal(compiler.compilations, before);
          },
        ),
      ],
    }),
  );
});
