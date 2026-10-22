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

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import {
  createBackofficeServiceExecution,
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
} from "@/backoffice-runtime/context";
import type { InMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";
import { builtJavaScriptModuleSchema } from "@/fragno/codemode/built-javascript-module";
import { codemodeRunnerFor } from "@/fragno/codemode/codemode-object-execute";
import { runBackofficeCompiledModule } from "@/fragno/codemode/compiled-module-execute";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { executeBackofficeRuntimeTool } from "@/fragno/runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";

import { javaScriptBuildToolFamily } from "./javascript";

const scenarioObjects = allLocalObjects;
const scope = { kind: "org", orgId: "org-1" } as const;
const sourcePath = "/workspace/scripts/example.js";
const outputPath = "/workspace/.build/example.module.json";
const simpleSource = 'export default { greeting: "hello" };';
const compiler = { available: true, compilations: 0 };
let server: Awaited<ReturnType<typeof createCodemodeTestServer>>;
beforeAll(async () => {
  server = await createCodemodeTestServer(
    (compile) => async (input) => {
      compiler.compilations += 1;
      if (!compiler.available) {
        throw new Error("Scenario compiler is unavailable.");
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

function workspace(runtime: InMemoryBackofficeRuntime) {
  return createCodemodeRouteBackedRuntimeContext({
    emitter: { kind: "caller" },
    runtime: runtime.services,
    kernel: new BackofficeKernel(runtime.services),
    execution: createBackofficeServiceExecution({
      scope,
      service: { type: "automation", id: "module-builder" },
    }),
  });
}

async function buildModule(runtime: InMemoryBackofficeRuntime) {
  return await executeBackofficeRuntimeTool(
    javaScriptBuildToolFamily.tools[0],
    { path: sourcePath, out: outputPath },
    createBackofficeToolContext(workspace(runtime)),
  );
}

test("js.build publishes ordinary ES modules without executing or inspecting their exports", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "generic JavaScript module build",
      env: { codemode: createCodemodeNodeExecutor(server) },
      setup: ({ given }) => [
        given.organization.exists({ id: "org-1" }),
        given.codemode.writeFile({
          orgId: "org-1",
          path: "/workspace/scripts/math.js",
          content: "export const add = (a, b) => a + b; export default { greeting: 'hello' };",
        }),
        given.codemode.writeFile({
          orgId: "org-1",
          path: "/workspace/scripts/deferred.js",
          content: "throw new Error('Only execution may run this'); export const value = 42;",
        }),
      ],
      steps: ({ then }) => [
        then.assert(
          "generic code builds and consumers choose how to invoke it",
          async ({ runtime }) => {
            const context = workspace(runtime);
            const { bash } = await createInteractiveBashHost({ context });
            for (const name of ["math", "deferred"]) {
              const result = await bash.exec(
                `js.build scripts/${name}.js --out .build/${name}.module.json --format json`,
                { cwd: "/workspace" },
              );
              assert.equal(result.exitCode, 0, result.stderr);
            }
            const builtModule = builtJavaScriptModuleSchema.parse(
              await context.stateBackend.readJson("/workspace/.build/math.module.json"),
            );
            const { bundle } = builtModule;
            await context.stateBackend.rm("/workspace/scripts/math.js");
            const before = compiler.compilations;
            compiler.available = false;
            const codemode = codemodeRunnerFor(
              runtime.objects.codemode.for(scope).commands,
              createBackofficeSystemExecution(scope),
            );
            assert.equal(
              await runBackofficeCompiledModule({
                bundle,
                invocation: "(module, input) => module.add(...input)",
                input: [20, 22],
                providers: [],
                codemode,
                origin: { kind: "file", path: "/workspace/.build/test.module.json" },
                signal: null,
              }),
              42,
            );
            assert.equal(
              await runBackofficeCompiledModule({
                bundle,
                invocation: "module => module.default.greeting",
                input: null,
                providers: [],
                codemode,
                origin: { kind: "file", path: "/workspace/.build/test.module.json" },
                signal: null,
              }),
              "hello",
            );
            const deferred = builtJavaScriptModuleSchema.parse(
              await context.stateBackend.readJson("/workspace/.build/deferred.module.json"),
            );
            await expect(
              runBackofficeCompiledModule({
                bundle: deferred.bundle,
                invocation: "module => module.value",
                input: null,
                providers: [],
                codemode,
                origin: { kind: "file", path: "/workspace/.build/test.module.json" },
                signal: null,
              }),
            ).rejects.toThrow("Only execution may run this");
            assert.equal(compiler.compilations, before);
          },
        ),
      ],
    }),
  );
});

for (const invalid of [
  { name: "syntax", source: "export default {", status: "error", error: "Expected identifier" },
  {
    name: "unresolved import",
    source: 'import "./missing.js"; export default {};',
    // Imports are resolved before compilation, so no build run is recorded.
    status: "rejected",
    error: "missing.js",
  },
]) {
  test(`failed ${invalid.name} build preserves the previous built module without executing source`, async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: `failed build ${invalid.name}`,
        env: { codemode: createCodemodeNodeExecutor(server) },
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1" }),
          given.codemode.writeFile({ orgId: "org-1", path: sourcePath, content: simpleSource }),
        ],
        steps: ({ then }) => [
          then.assert("the last complete built module remains usable", async ({ runtime }) => {
            expect(await buildModule(runtime)).toMatchObject({ status: "success" });
            const state = workspace(runtime).stateBackend;
            const previous = await state.readFile(outputPath);
            await state.writeFile(sourcePath, invalid.source);
            const result = await buildModule(runtime);
            expect(result).toMatchObject({ status: invalid.status, outputPath });
            expect(JSON.stringify(result).toLowerCase()).toContain(invalid.error.toLowerCase());
            assert.equal(await state.readFile(outputPath), previous);
          }),
        ],
      }),
    );
  });
}

test("js.build validates CLI inputs and scoped modification authority before compiling", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "build input and authority boundaries",
      env: { codemode: createCodemodeNodeExecutor(server) },
      setup: ({ given }) => [
        given.organization.exists({ id: "org-1" }),
        given.auth.user({ id: "outsider", email: "outsider@example.test" }),
        given.codemode.writeFile({ orgId: "org-1", path: sourcePath, content: simpleSource }),
      ],
      steps: ({ then }) => [
        then.assert("rejected commands publish nothing", async ({ runtime }) => {
          const before = compiler.compilations;
          const context = workspace(runtime);
          const { bash } = await createInteractiveBashHost({ context });
          for (const command of [
            `js.build ${sourcePath}`,
            `js.build ${sourcePath} --target unsupported --out ${outputPath}`,
            `js.build ${sourcePath} --out ${outputPath} --unknown flag`,
            `js.build ${sourcePath} --out /static/escape.module.json`,
            `js.build /workspace/other.js --out ${outputPath}`,
          ]) {
            const result = await bash.exec(command);
            expect(result.exitCode, command).not.toBe(0);
          }
          const deniedContext = createCodemodeRouteBackedRuntimeContext({
            emitter: { kind: "caller" },
            runtime: runtime.services,
            kernel: new BackofficeKernel(runtime.services),
            execution: createBackofficeUserExecution({ scope, userId: "outsider" }),
          });
          const denied = await (
            await createInteractiveBashHost({ context: deniedContext })
          ).bash.exec(`js.build ${sourcePath} --out ${outputPath}`);
          expect(denied.exitCode).not.toBe(0);
          assert.equal(compiler.compilations, before);
          assert.equal(await context.stateBackend.exists(outputPath), false);
        }),
      ],
    }),
  );
});
