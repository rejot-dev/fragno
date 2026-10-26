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
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";
import { builtJavaScriptModuleSchema } from "@/fragno/codemode/built-javascript-module";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { executeBackofficeRuntimeTool } from "@/fragno/runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";

import { ApiObject } from "../../../../workers/api-object";
import { AppInstallationsObject } from "../../../../workers/app-installations-object";
import { AppsObject } from "../../../../workers/apps-object";
import { AuthObject } from "../../../../workers/auth-object";
import { AutomationsObject } from "../../../../workers/automations-object";
import { CodemodeObject } from "../../../../workers/codemode-object";
import { FormsObject } from "../../../../workers/forms-object";
import { McpObject } from "../../../../workers/mcp-object";
import { TelegramObject } from "../../../../workers/telegram-object";
import { UploadObject } from "../../../../workers/upload-object";
import { javaScriptRunToolFamily } from "./javascript";

const scenarioObjects = {
  API: (input) => new ApiObject(input),
  APPS: (input) => new AppsObject(input),
  APP_INSTALLATIONS: (input) => new AppInstallationsObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  FORMS: (input) => new FormsObject(input),
  MCP: (input) => new McpObject(input),
  TELEGRAM: (input) => new TelegramObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

let server: Awaited<ReturnType<typeof createCodemodeTestServer>>;
const compiler = { available: true, compilations: 0 };
beforeAll(async () => {
  server = await createCodemodeTestServer(
    (compile) => async (input) => {
      compiler.compilations++;
      if (!compiler.available) {
        throw new Error("Run must not compile a built module");
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
const outputPath = "/workspace/.build/example.module.json";

test("js.run executes bundled top-level statements and dependencies with the compiler offline, ignoring exports", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "public built module execution",
      env: { codemode: createCodemodeNodeExecutor(server) },
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
              emitter: { kind: "caller" },
              runtime: runtime.services,
              kernel: new BackofficeKernel(runtime.services),
              execution: createBackofficeServiceExecution({
                scope,
                service: { type: "automation", id: "module-runner" },
              }),
            });
            const { bash } = await createInteractiveBashHost({ context });
            const built = await bash.exec(
              `js.build scripts/example.js --out .build/example.module.json`,
              { cwd: "/workspace" },
            );
            assert.equal(built.exitCode, 0, built.stderr);
            const builtModule = builtJavaScriptModuleSchema.parse(
              await context.stateBackend.readJson(outputPath),
            );
            await context.stateBackend.writeFile(
              outputPath,
              JSON.stringify({
                ...builtModule,
                bundle: {
                  ...builtModule.bundle,
                  modules: {
                    ...builtModule.bundle.modules,
                    [builtModule.bundle.mainModule]:
                      `import "./dependency.js";\n${builtModule.bundle.modules[builtModule.bundle.mainModule]}`,
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
              path: outputPath,
              logs: [
                { at: expect.any(Number), channel: "log", text: "dependency startup" },
                { at: expect.any(Number), channel: "log", text: "main startup 0" },
              ],
            });
            const repeated = await executeBackofficeRuntimeTool(
              javaScriptRunToolFamily.tools[0],
              { path: outputPath },
              createBackofficeToolContext(context),
            );
            // Each run is recorded separately.
            expect(repeated).toEqual({ ...parsed, runId: expect.any(String) });
            expect(repeated).not.toHaveProperty("runId", parsed.runId);
            assert.equal(compiler.compilations, before);
            const deniedContext = createCodemodeRouteBackedRuntimeContext({
              emitter: { kind: "caller" },
              runtime: runtime.services,
              kernel: new BackofficeKernel(runtime.services),
              execution: createBackofficeUserExecution({ scope, userId: "outsider" }),
            });
            const denied = await (
              await createInteractiveBashHost({ context: deniedContext })
            ).bash.exec(`js.run ${outputPath}`);
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
        objects: scenarioObjects,
        name: invalid.name,
        env: { codemode: createCodemodeNodeExecutor(server) },
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
              emitter: { kind: "caller" },
              runtime: runtime.services,
              kernel: new BackofficeKernel(runtime.services),
              execution: createBackofficeServiceExecution({
                scope,
                service: { type: "automation", id: "module-runner" },
              }),
            });
            const { bash } = await createInteractiveBashHost({ context });
            assert.equal(
              (await bash.exec(`js.build /workspace/scripts/invalid.js --out ${outputPath}`))
                .exitCode,
              0,
            );
            const before = compiler.compilations;
            compiler.available = false;
            const failed = await bash.exec(`js.run ${outputPath} --format json`);
            assert.notEqual(failed.exitCode, 0);
            expect(JSON.parse(failed.stdout)).toMatchObject({
              status: "error",
              path: outputPath,
              error: expect.stringContaining(invalid.error),
            });
            assert.equal(compiler.compilations, before);
          }),
        ],
      }),
    );
  });
}

test("js.run validates built module format, entrypoint, runtime, JSON and scope before execution", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "built module execution boundary",
      env: { codemode: createCodemodeNodeExecutor(server) },
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
          "bad built modules are rejected without running their code",
          async ({ runtime }) => {
            const context = createCodemodeRouteBackedRuntimeContext({
              emitter: { kind: "caller" },
              runtime: runtime.services,
              kernel: new BackofficeKernel(runtime.services),
              execution: createBackofficeServiceExecution({
                scope,
                service: { type: "automation", id: "module-runner" },
              }),
            });
            const { bash } = await createInteractiveBashHost({ context });
            assert.equal(
              (await bash.exec(`js.build /workspace/scripts/example.js --out ${outputPath}`))
                .exitCode,
              0,
            );
            const builtModule = builtJavaScriptModuleSchema.parse(
              await context.stateBackend.readJson(outputPath),
            );
            const before = compiler.compilations;
            compiler.available = false;
            for (const content of [
              "{",
              JSON.stringify({ format: "unknown", bundle: builtModule.bundle }),
              JSON.stringify({
                ...builtModule,
                bundle: { ...builtModule.bundle, mainModule: "missing.js" },
              }),
              JSON.stringify({
                ...builtModule,
                bundle: {
                  ...builtModule.bundle,
                  runtime: { compatibilityDate: "2026-05-07", compatibilityFlags: ["unsafe"] },
                },
              }),
            ]) {
              await context.stateBackend.writeFile(outputPath, content);
              const failed = await bash.exec(`js.run ${outputPath} --format json`);
              assert.notEqual(failed.exitCode, 0);
              expect(JSON.parse(failed.stdout)).toEqual({
                status: "rejected",
                path: outputPath,
                error: expect.any(String),
              });
            }
            const other = createCodemodeRouteBackedRuntimeContext({
              emitter: { kind: "caller" },
              runtime: runtime.services,
              kernel: new BackofficeKernel(runtime.services),
              execution: createBackofficeServiceExecution({
                scope: { kind: "org", orgId: "org-2" },
                service: { type: "automation", id: "module-runner" },
              }),
            });
            const missing = await (
              await createInteractiveBashHost({ context: other })
            ).bash.exec(`js.run ${outputPath} --format json`);
            assert.notEqual(missing.exitCode, 0);
            expect(missing.stdout).toContain("JAVASCRIPT_RUN_BUILT_MODULE_MISSING");
            assert.equal(compiler.compilations, before);
          },
        ),
      ],
    }),
  );
});
