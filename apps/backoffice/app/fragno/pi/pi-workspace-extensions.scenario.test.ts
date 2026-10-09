import { afterAll, afterEach, beforeAll, assert, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { fileURLToPath } from "node:url";

import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { createCodemodeNodeExecutor } from "@fragno-dev/codemode/remote/codemode-node-executor";
import { createCodemodeTestServer } from "@fragno-dev/codemode/testing/codemode-test-server";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createRegistry, type ConversationView } from "@earendil-works/pi-durable";

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import {
  createBackofficeServiceExecution,
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
  type BackofficeContextScope,
} from "@/backoffice-runtime/context";
import type { InMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";
import { runBackofficeCompiledModule } from "@/fragno/codemode/compiled-module-execute";
import { javaScriptModuleArtifactSchema } from "@/fragno/codemode/javascript-module-artifact";
import type { PiAgentConfig } from "@/fragno/pi-manager/pi-agent-contract";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { javaScriptBuildToolFamily } from "@/fragno/runtime-tools/families/javascript";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { executeBackofficeRuntimeTool } from "@/fragno/runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";

import { InMemoryPiObject } from "../../../workers/pi.do";

const scenarioObjects = allLocalObjects;

const scope = { kind: "org", orgId: "org-1" } as const;
const manifestPath = "/workspace/pi/extensions.json";
const extensionPath = "/workspace/scripts/project-context.js";
const artifactPath = "/workspace/.build/project-context.module.json";
const manifest = JSON.stringify({ extensions: [artifactPath] });
const extensionSource = `import { defineExtension, section } from "@earendil-works/pi-durable";
export default defineExtension({
  name: "project-context",
  sections: [
    section("project_context", async ({ env }) => {
      const result = await env.readTextFile("/workspace/AGENTS.md");
      if (!result.ok) throw result.error;
      return result.value;
    }),
    section("file_presence", async ({ env }) =>
      (await env.exists("later.txt")).value ? "Later file exists" : "No later file"),
    section("plain_context", () => "Unwrapped extension guidance", { tag: false }),
    section("omitted_context", () => undefined),
  ],
});`;
const simpleSource =
  'export default { name: "simple", sections: [{ key: "simple_context", render: () => "Valid extension guidance" }] };';
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
    fileURLToPath(new URL("../../../", import.meta.url)),
  );
});
afterEach(() => {
  compiler.available = true;
});
afterAll(async () => {
  await server?.close();
});

function scriptedExtensionAgents(
  responses: FauxResponseStep[],
  reports: unknown[],
): LocalBackofficeObjects {
  return {
    PI: ({ state, runtime, openPiSessionStore, piAgentIdFromConfig, nowEpochMs }) => {
      const faux = fauxProvider();
      faux.setResponses([...responses, ...responses]);
      const models = createModels();
      models.setProvider(faux.provider);
      return new InMemoryPiObject({
        state,
        runtime,
        options: { models, registry: createRegistry(), onReport: (error) => reports.push(error) },
        openStorage: openPiSessionStore,
        idFromConfig: piAgentIdFromConfig,
        nowEpochMs,
      });
    },
  };
}

function workspace(
  runtime: InMemoryBackofficeRuntime,
  selectedScope: BackofficeContextScope = scope,
) {
  return createCodemodeRouteBackedRuntimeContext({
    runtime: runtime.services,
    kernel: new BackofficeKernel(runtime.services),
    execution: createBackofficeServiceExecution({
      scope: selectedScope,
      service: { type: "automation", id: "extension-builder" },
    }),
    billingOrganizationId: null,
  });
}

async function buildExtension(
  runtime: InMemoryBackofficeRuntime,
  selectedScope: BackofficeContextScope = scope,
) {
  return await executeBackofficeRuntimeTool(
    javaScriptBuildToolFamily.tools[0],
    { path: extensionPath, out: artifactPath },
    createBackofficeToolContext(workspace(runtime, selectedScope)),
  );
}

async function request(
  runtime: InMemoryBackofficeRuntime,
  route: string,
  body: unknown,
  selectedScope: BackofficeContextScope = scope,
) {
  const execution =
    selectedScope.kind === "system"
      ? createBackofficeSystemExecution(selectedScope)
      : createBackofficeServiceExecution({
          scope: selectedScope,
          service: { type: "automation", id: "workspace-extension-scenario" },
        });
  return await runtime.objects.piManager.for(selectedScope).http.fetchAuthorized(
    new Request(`https://pi-manager.test/api/pi-manager${route}`, {
      method: body === null ? "GET" : "POST",
      headers: body === null ? {} : { "content-type": "application/json" },
      body: body === null ? undefined : JSON.stringify(body),
    }),
    { execution, propagationContext: null },
  );
}

async function createAgent(
  runtime: InMemoryBackofficeRuntime,
  selectedScope: BackofficeContextScope = scope,
): Promise<PiAgentConfig> {
  const response = await request(
    runtime,
    "/sessions",
    {
      name: "Workspace extension agent",
      model: { provider: "faux", modelId: "faux-1" },
      instructions: "Keep the session instruction.",
      billingOrganizationId: selectedScope.kind === "system" ? null : "org-1",
    },
    selectedScope,
  );
  assert.equal(response.status, 201, await response.clone().text());
  return await response.json<PiAgentConfig>();
}

async function runPrompt(
  runtime: InMemoryBackofficeRuntime,
  agent: PiAgentConfig,
  requestId: string,
) {
  const response = await request(
    runtime,
    `/sessions/${agent.sessionId}/prompts`,
    {
      requestId,
      content: "Use workspace guidance.",
    },
    agent.scope,
  );
  assert.equal(response.status, 202, await response.clone().text());
  await runtime.drain();
  const view = await request(runtime, `/sessions/${agent.sessionId}/view`, null, agent.scope);
  assert.equal(view.status, 200, await view.clone().text());
  return await view.json<ConversationView>();
}

function errorMessages(error: unknown): string {
  return error instanceof Error ? `${error.message} ${errorMessages(error.cause)}` : String(error);
}

test("js.build publishes ordinary ES modules without executing or inspecting their exports", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "generic JavaScript module build",
      env: { codemode: { remoteExecutor: createCodemodeNodeExecutor(server) } },
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
            const { bash } = createInteractiveBashHost({ context });
            for (const name of ["math", "deferred"]) {
              const result = await bash.exec(
                `js.build scripts/${name}.js --out .build/${name}.module.json --format json`,
                { cwd: "/workspace" },
              );
              assert.equal(result.exitCode, 0, result.stderr);
            }
            const artifact = javaScriptModuleArtifactSchema.parse(
              await context.stateBackend.readJson("/workspace/.build/math.module.json"),
            );
            const { bundle } = artifact;
            expect(Object.values(bundle.modules).join("\n")).not.toContain("PI_EXTENSION_");
            await context.stateBackend.rm("/workspace/scripts/math.js");
            const before = compiler.compilations;
            compiler.available = false;
            const env = runtime.services.codemodeEnv;
            assert(env);
            assert.equal(
              await runBackofficeCompiledModule({
                bundle,
                invocation: "(module, input) => module.add(...input)",
                input: [20, 22],
                providers: [],
                env,
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
                env,
                signal: null,
              }),
              "hello",
            );
            const deferred = javaScriptModuleArtifactSchema.parse(
              await context.stateBackend.readJson("/workspace/.build/deferred.module.json"),
            );
            await expect(
              runBackofficeCompiledModule({
                bundle: deferred.bundle,
                invocation: "module => module.value",
                input: null,
                providers: [],
                env,
                signal: null,
              }),
            ).rejects.toThrow("Only execution may run this");
            assert.equal(compiler.compilations, before);
            assert.equal(await context.stateBackend.exists(manifestPath), false);
          },
        ),
      ],
    }),
  );
});

test("js.build bundles native imports once; Pi inspects and renders fresh files with the compiler offline", async () => {
  const reports: unknown[] = [];
  let modelCalls = 0;
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "precompiled native workspace extension through Node, Cap'n Web and workerd",
      env: { codemode: { remoteExecutor: createCodemodeNodeExecutor(server) } },
      options: { drain: false },
      piAvailableModels: [{ provider: "faux", modelId: "faux-1", label: "Faux 1" }],
      objects: {
        ...scenarioObjects,
        ...scriptedExtensionAgents(
          [
            (context) => {
              modelCalls += 1;
              const system = JSON.stringify(
                context.messages.filter((message) => message.role === "system"),
              );
              expect(system).toContain(
                modelCalls === 1 ? "Initial workspace guidance" : "Updated workspace guidance",
              );
              expect(system).toContain("project_context");
              expect(system).toContain(modelCalls === 1 ? "No later file" : "Later file exists");
              expect(system).not.toContain("Other organization guidance");
              expect(system).toContain("Unwrapped extension guidance");
              expect(system).not.toContain("<plain_context>");
              expect(system).not.toContain("omitted_context");
              expect(system).toContain("# Backoffice System Guidance");
              expect(system).toContain("Keep the session instruction.");
              return fauxAssistantMessage(`Extension answer ${modelCalls}.`);
            },
          ],
          reports,
        ),
      },
      setup: ({ given }) => [
        given.organization.exists({ id: "org-1" }),
        given.organization.exists({ id: "org-2" }),
        given.codemode.writeFile({ orgId: "org-1", path: manifestPath, content: manifest }),
        given.codemode.writeFile({ orgId: "org-1", path: extensionPath, content: extensionSource }),
        given.codemode.writeFile({
          orgId: "org-1",
          path: "/workspace/AGENTS.md",
          content: "Initial workspace guidance",
        }),
        given.codemode.writeFile({
          orgId: "org-1",
          path: "/workspace/pi/extensions/unlisted.extension.js",
          content: 'throw new Error("Unlisted source must not execute");',
        }),
        given.codemode.writeFile({ orgId: "org-2", path: manifestPath, content: manifest }),
        given.codemode.writeFile({
          orgId: "org-2",
          path: extensionPath,
          content:
            'export default { name: "other-org", sections: [{ key: "other_org", render: () => "Other organization guidance" }] };',
        }),
      ],
      steps: ({ then }) => [
        then.assert("build once and render repeatedly without compiling", async ({ runtime }) => {
          expect(await buildExtension(runtime, { kind: "org", orgId: "org-2" })).toMatchObject({
            status: "success",
          });
          const before = compiler.compilations;
          const context = workspace(runtime);
          const { bash } = createInteractiveBashHost({ context });
          const built = await bash.exec(
            "js.build scripts/project-context.js --out .build/project-context.module.json --format json",
            { cwd: "/workspace" },
          );
          expect(built.exitCode, built.stderr).toBe(0);
          expect(JSON.parse(built.stdout)).toMatchObject({ status: "success", artifactPath });
          assert.equal(compiler.compilations - before, 1);
          const afterBuild = compiler.compilations;
          compiler.available = false;
          const agent = await createAgent(runtime);
          expect(JSON.stringify((await runPrompt(runtime, agent, "first")).entries)).toContain(
            "Extension answer 1.",
          );
          await context.stateBackend.writeFile(
            "/workspace/AGENTS.md",
            "Updated workspace guidance",
          );
          await context.stateBackend.writeFile("/workspace/later.txt", "new file");
          expect(JSON.stringify((await runPrompt(runtime, agent, "second")).entries)).toContain(
            "Extension answer 2.",
          );
          const reopened = await createAgent(runtime);
          expect(
            JSON.stringify((await runPrompt(runtime, reopened, "new-session")).entries),
          ).toContain("Extension answer 3.");
          expect(compiler.compilations).toBe(afterBuild);
          expect(reports).toEqual([]);
        }),
      ],
    }),
  );
});

test("native workspace tools and built-in hooks run through sealed codemode with scoped capabilities", async () => {
  const reports: unknown[] = [];
  let calls = 0;
  const source = `import { defineExtension, defineTool, section, hook, GenerationTask, ToolTask } from "@earendil-works/pi-durable";
  let invocations = 0;
  export default defineExtension({
    name: "simple-bridge",
    sections: [section("bridge_context", ({ shown }, context) => {
      if (context.value({ token: Symbol() }) !== undefined) throw new Error("Host context leaked");
      return "Guest state " + (++invocations) + "; shown " + Object.keys(shown).length;
    })],
    tools: [defineTool({
      name: "workspace_summary", description: "Read scoped workspace guidance.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      executionMode: "sequential", replay: "safe", outputLimits: { maxBytes: 4096, retain: "tail" },
      execute: async (args, api, context) => {
        if (++invocations !== 1) throw new Error("Guest globals persisted");
        if (await api.memo("prepared", context) !== "hook memo") throw new Error("Hook memo missing");
        if (await api.memo("prepared", "losing candidate", context) !== "hook memo") throw new Error("Memo was overwritten");
        const text = await api.providers.state.readFile({ path: args.path });
        const exists = await api.env.exists(args.path);
        if (!exists.ok || !exists.value) throw new Error("Scoped environment missing");
        api.output(new TextEncoder().encode("Loaded: " + text));
        api.diagnostic({ severity: "info", message: "Guest tool completed", code: "bridge_report" });
        await api.details({ path: args.path, conversationId: api.conversationId, callId: api.callId }, context);
        return {};
      },
    })],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: request => ({ messages: [...request.messages, { role: "user", content: "Bridge request hook", timestamp: 0 }] }),
        afterResponse: async (message, api, context) => { await api.memo("response", message.content[0]?.text ?? "tool-round", context); },
        afterTools: async (assistant, results, api, context) => {
          if (typeof assistant !== "number" || results.length !== 2) throw new Error("Invalid afterTools arguments");
          await api.memo("tools-seen", true, context);
        },
        onYield: async (answer, api, context) => {
          if (await api.memo("response", context) !== answer.content[0]?.text) throw new Error("afterResponse was not invoked");
          if (answer.content[0]?.text === "First bridge answer") return { continue: "Bridge continuation hook" };
        },
      }),
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          if (call.name === "execCodeMode") return { block: "Guest hook blocked built-in codemode" };
          if (call.name === "workspace_summary") {
            await api.memo("prepared", "hook memo", context);
            return { arguments: { path: "/workspace/AGENTS.md" } };
          }
        },
        afterTool: (call, result) => call.name === "workspace_summary"
          ? { ...result, content: [{ type: "text", text: "Hook processed: " + (result.content[0]?.text ?? JSON.stringify(result.diagnostics)) }] }
          : undefined,
      }),
    ],
  });`;
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "simple native extension bridge",
      env: { codemode: { remoteExecutor: createCodemodeNodeExecutor(server) } },
      options: { drain: false },
      piAvailableModels: [{ provider: "faux", modelId: "faux-1", label: "Faux 1" }],
      objects: {
        ...scenarioObjects,
        ...scriptedExtensionAgents(
          [
            (context): AssistantMessage => {
              calls++;
              expect(JSON.stringify(context.messages)).toContain("Bridge request hook");
              expect(JSON.stringify(context.messages)).toContain("Guest state 1");
              return {
                ...fauxAssistantMessage(""),
                stopReason: "toolUse",
                content: [
                  {
                    type: "toolCall",
                    id: "bridge-summary",
                    name: "workspace_summary",
                    arguments: { path: "/workspace/missing.txt" },
                  },
                  {
                    type: "toolCall",
                    id: "bridge-blocked",
                    name: "execCodeMode",
                    arguments: { code: "async () => { throw new Error('Must not execute'); }" },
                  },
                ],
              };
            },
            (context) => {
              calls++;
              expect(JSON.stringify(context.messages)).toContain(
                "Hook processed: Loaded: Scoped bridge guidance",
              );
              expect(JSON.stringify(context.messages)).toContain(
                "Guest hook blocked built-in codemode",
              );
              expect(JSON.stringify(context.messages)).not.toContain("Other scope secret");
              return fauxAssistantMessage("First bridge answer");
            },
            (context) => {
              calls++;
              expect(JSON.stringify(context.messages)).toContain("Bridge continuation hook");
              return fauxAssistantMessage("Final bridge answer");
            },
          ],
          reports,
        ),
      },
      setup: ({ given }) => [
        given.organization.exists({ id: "org-1" }),
        given.organization.exists({ id: "org-2" }),
        given.codemode.writeFile({ orgId: "org-1", path: manifestPath, content: manifest }),
        given.codemode.writeFile({ orgId: "org-1", path: extensionPath, content: source }),
        given.codemode.writeFile({
          orgId: "org-1",
          path: "/workspace/AGENTS.md",
          content: "Scoped bridge guidance",
        }),
        given.codemode.writeFile({
          orgId: "org-2",
          path: "/workspace/AGENTS.md",
          content: "Other scope secret",
        }),
      ],
      steps: ({ then }) => [
        then.assert(
          "native tool reports and hook decisions reach the durable transcript",
          async ({ runtime }) => {
            expect(await buildExtension(runtime)).toMatchObject({ status: "success" });
            const before = compiler.compilations;
            compiler.available = false;
            const view = await runPrompt(runtime, await createAgent(runtime), "simple-bridge");
            expect(reports.map(errorMessages)).toEqual([]);
            expect(calls).toBe(3);
            expect(JSON.stringify(view.entries)).toContain("Final bridge answer");
            const tool = view.entries
              .flatMap((entry) => entry.model ?? [])
              .find(
                (message) =>
                  message.role === "toolResult" && message.toolCallId === "bridge-summary",
              );
            expect(tool).toMatchObject({
              role: "toolResult",
              isError: false,
              details: { path: "/workspace/AGENTS.md", callId: "bridge-summary" },
            });
            expect(
              view.entries.find(
                (entry) =>
                  entry.kind === "pi.tool-result" &&
                  entry.model?.[0]?.role === "toolResult" &&
                  entry.model[0].toolCallId === "bridge-summary",
              )?.data,
            ).toMatchObject({ diagnostics: [{ severity: "info", code: "bridge_report" }] });
            expect(reports).toEqual([]);
            expect(compiler.compilations).toBe(before);
          },
        ),
      ],
    }),
  );
});

test("user, project and system sessions do not inherit organization build artifacts", async () => {
  const reports: unknown[] = [];
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "built extension scope isolation",
      env: { codemode: { remoteExecutor: createCodemodeNodeExecutor(server) } },
      options: { drain: false },
      piAvailableModels: [{ provider: "faux", modelId: "faux-1", label: "Faux 1" }],
      objects: {
        ...scenarioObjects,
        ...scriptedExtensionAgents(
          [
            (context) => {
              expect(JSON.stringify(context.messages)).not.toContain("Valid extension guidance");
              return fauxAssistantMessage("No inherited extension.");
            },
          ],
          reports,
        ),
      },
      setup: ({ given }) => [
        given.organization.exists({ id: "org-1" }),
        given.codemode.writeFile({ orgId: "org-1", path: extensionPath, content: simpleSource }),
        given.codemode.writeFile({ orgId: "org-1", path: manifestPath, content: manifest }),
      ],
      steps: ({ then }) => [
        then.assert("only the exact workspace activates an artifact", async ({ runtime }) => {
          expect(await buildExtension(runtime)).toMatchObject({ status: "success" });
          compiler.available = false;
          for (const selectedScope of [
            { kind: "user", userId: "isolated-user" },
            { kind: "project", orgId: "org-1", projectId: "isolated-project" },
            { kind: "system" },
          ] satisfies BackofficeContextScope[]) {
            const agent = await createAgent(runtime, selectedScope);
            expect(
              JSON.stringify((await runPrompt(runtime, agent, "scope-isolation")).entries),
            ).toContain("No inherited extension.");
          }
          expect(reports).toEqual([]);
        }),
      ],
    }),
  );
});

test("source edits require an explicit rebuild and existing sessions retain their captured artifact", async () => {
  const reports: unknown[] = [];
  let modelCalls = 0;
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "explicit build lifecycle",
      env: { codemode: { remoteExecutor: createCodemodeNodeExecutor(server) } },
      options: { drain: false },
      piAvailableModels: [{ provider: "faux", modelId: "faux-1", label: "Faux 1" }],
      objects: {
        ...scenarioObjects,
        ...scriptedExtensionAgents(
          [
            (context) => {
              modelCalls += 1;
              expect(JSON.stringify(context.messages)).toContain(
                modelCalls < 4 ? "Code revision one" : "Code revision two",
              );
              return fauxAssistantMessage(`Lifecycle answer ${modelCalls}.`);
            },
          ],
          reports,
        ),
      },
      setup: ({ given }) => [
        given.organization.exists({ id: "org-1" }),
        given.codemode.writeFile({ orgId: "org-1", path: manifestPath, content: manifest }),
        given.codemode.writeFile({
          orgId: "org-1",
          path: extensionPath,
          content:
            'export default { name: "code-lifecycle", sections: [{ key: "code_lifecycle", render: () => "Code revision one" }] };',
        }),
      ],
      steps: ({ then }) => [
        then.assert(
          "only rebuilt artifacts affect subsequently opened sessions",
          async ({ runtime }) => {
            expect(await buildExtension(runtime)).toMatchObject({ status: "success" });
            const agent = await createAgent(runtime);
            await runPrompt(runtime, agent, "original");
            await workspace(runtime).stateBackend.writeFile(
              extensionPath,
              'export default { name: "code-lifecycle", sections: [{ key: "code_lifecycle", render: () => "Code revision two" }] };',
            );
            await runPrompt(runtime, await createAgent(runtime), "source-only-edit");
            expect(await buildExtension(runtime)).toMatchObject({ status: "success" });
            await runPrompt(runtime, agent, "existing-session-after-rebuild");
            await runPrompt(runtime, await createAgent(runtime), "new-session-after-rebuild");
            expect(modelCalls).toBe(4);
            expect(reports).toEqual([]);
          },
        ),
      ],
    }),
  );
});

for (const invalid of [
  { name: "syntax", source: "export default {", error: "Expected identifier" },
  {
    name: "unresolved import",
    source: 'import "./missing.js"; export default {};',
    error: "missing.js",
  },
]) {
  test(`failed ${invalid.name} build preserves the previous artifact and does not activate source`, async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: `failed build ${invalid.name}`,
        env: { codemode: { remoteExecutor: createCodemodeNodeExecutor(server) } },
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1" }),
          given.codemode.writeFile({ orgId: "org-1", path: extensionPath, content: simpleSource }),
        ],
        steps: ({ then }) => [
          then.assert("the last complete artifact remains usable", async ({ runtime }) => {
            expect(await buildExtension(runtime)).toMatchObject({ status: "success" });
            const state = workspace(runtime).stateBackend;
            const previous = await state.readFile(artifactPath);
            await state.writeFile(extensionPath, invalid.source);
            const result = await buildExtension(runtime);
            expect(result).toMatchObject({ status: "error", artifactPath });
            expect(JSON.stringify(result).toLowerCase()).toContain(invalid.error.toLowerCase());
            assert.equal(await state.readFile(artifactPath), previous);
            assert.equal(await state.exists(manifestPath), false);
          }),
        ],
      }),
    );
  });
}

for (const invalid of [
  {
    name: "ordinary module",
    source: "export const value = 42;",
    error: "PI_EXTENSION_INVALID_EXPORT",
  },
  {
    name: "missing render function",
    source: 'export default { name: "invalid", sections: [{ key: "bad", render: 42 }] };',
    error: "PI_EXTENSION_INVALID_SECTION",
  },
  {
    name: "dotted section key",
    source:
      'export default { name: "invalid", sections: [{ key: "project.context", render: () => "bad" }] };',
    error: "must match",
  },
  {
    name: "uppercase section key",
    source:
      'export default { name: "invalid", sections: [{ key: "ProjectContext", render: () => "bad" }] };',
    error: "must match",
  },
  {
    name: "tasks",
    source: 'export default { name: "unsafe", tasks: [] };',
    error: "PI_EXTENSION_UNSUPPORTED_MEMBER",
  },
  {
    name: "wrappers",
    source: 'export default { name: "unsafe", wraps: [] };',
    error: "PI_EXTENSION_UNSUPPORTED_MEMBER",
  },
  {
    name: "argument preparation",
    source:
      'export default { name: "unsafe", tools: [{ name: "unsafe", description: "Unsafe", parameters: { type: "object" }, execute: async () => ({}), prepareArguments: args => args }] };',
    error: "PI_EXTENSION_UNSUPPORTED_TOOL_MEMBER",
  },
  {
    name: "custom task hook",
    source:
      'export default { name: "unsafe", hooks: [{ task: "custom.task", handlers: { beforeRun: () => undefined } }] };',
    error: "PI_EXTENSION_UNSUPPORTED_HOOK_TASK",
  },
  {
    name: "unknown built-in hook",
    source:
      'export default { name: "unsafe", hooks: [{ task: "pi.tool", handlers: { onStart: () => undefined } }] };',
    error: "PI_EXTENSION_UNSUPPORTED_HOOK",
  },
  {
    name: "built-in tool collision",
    source:
      'export default { name: "unsafe", tools: [{ name: "read", description: "Override", parameters: { type: "object" }, execute: async () => ({}) }] };',
    error: "PI_EXTENSION_DUPLICATE_TOOL",
  },
  {
    name: "duplicate tool",
    source:
      'const tool = { name: "duplicate", description: "Duplicate", parameters: { type: "object" }, execute: async () => ({}) }; export default { name: "unsafe", tools: [tool, tool] };',
    error: "two tools",
  },
  {
    name: "reserved section",
    source:
      'export default { name: "collision", sections: [{ key: "backoffice", render: () => "bad" }] };',
    error: "PI_EXTENSION_DUPLICATE_SECTION",
  },
  {
    name: "duplicate section",
    source:
      'export default { name: "duplicate", sections: [{ key: "same", render: () => "a" }, { key: "same", render: () => "b" }] };',
    error: "two sections",
  },
  {
    name: "top-level egress",
    source:
      'await fetch("https://example.com"); export default { name: "network", sections: [{ key: "network", render: () => "bad" }] };',
    error: "global scope",
  },
]) {
  test(`${invalid.name} builds as a module but fails sealed Pi inspection without compiling`, async () => {
    const reports: unknown[] = [];
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: `Pi inspection ${invalid.name}`,
        env: { codemode: { remoteExecutor: createCodemodeNodeExecutor(server) } },
        options: { drain: false },
        piAvailableModels: [{ provider: "faux", modelId: "faux-1", label: "Faux 1" }],
        objects: {
          ...scenarioObjects,
          ...scriptedExtensionAgents(
            [
              (context) => {
                expect(JSON.stringify(context.messages)).toContain("# Backoffice System Guidance");
                return fauxAssistantMessage("Invalid extension does not brick the session.");
              },
            ],
            reports,
          ),
        },
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1" }),
          given.codemode.writeFile({
            orgId: "org-1",
            path: extensionPath,
            content: invalid.source,
          }),
        ],
        steps: ({ then }) => [
          then.assert("compilation does not interpret or activate exports", async ({ runtime }) => {
            expect(await buildExtension(runtime)).toMatchObject({ status: "success" });
            const state = workspace(runtime).stateBackend;
            assert.equal(await state.exists(manifestPath), false);
            await state.writeFile(manifestPath, manifest);
            const before = compiler.compilations;
            compiler.available = false;
            expect(
              JSON.stringify(
                (await runPrompt(runtime, await createAgent(runtime), "invalid-extension")).entries,
              ),
            ).toContain("Invalid extension does not brick the session.");
            expect(reports).toHaveLength(1);
            expect(errorMessages(reports[0]).toLowerCase()).toContain(invalid.error.toLowerCase());
            assert.equal(compiler.compilations, before);
          }),
        ],
      }),
    );
  });
}

const artifactFailureCases = [
  {
    name: "unsupported artifact format",
    change: (artifact: ReturnType<typeof javaScriptModuleArtifactSchema.parse>) => ({
      ...artifact,
      format: "fragno-javascript-module/v0",
    }),
  },
  {
    name: "unsupported runtime flags",
    change: (artifact: ReturnType<typeof javaScriptModuleArtifactSchema.parse>) => ({
      ...artifact,
      bundle: {
        ...artifact.bundle,
        runtime: {
          ...artifact.bundle.runtime,
          compatibilityFlags: ["nodejs_compat", "unknown_flag"],
        },
      },
    }),
  },
  {
    name: "missing entry module",
    change: (artifact: ReturnType<typeof javaScriptModuleArtifactSchema.parse>) => ({
      ...artifact,
      bundle: { ...artifact.bundle, mainModule: "missing.js" },
    }),
  },
  {
    name: "unexpected consumer metadata",
    change: (artifact: ReturnType<typeof javaScriptModuleArtifactSchema.parse>) => ({
      ...artifact,
      extension: { name: "forged", sections: [] },
    }),
  },
];
for (const invalid of artifactFailureCases) {
  test(`${invalid.name} is reported without invoking a compiler or replacing built-in guidance`, async () => {
    const reports: unknown[] = [];
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: invalid.name,
        env: { codemode: { remoteExecutor: createCodemodeNodeExecutor(server) } },
        options: { drain: false },
        piAvailableModels: [{ provider: "faux", modelId: "faux-1", label: "Faux 1" }],
        objects: {
          ...scenarioObjects,
          ...scriptedExtensionAgents(
            [
              (context) => {
                expect(JSON.stringify(context.messages)).toContain("# Backoffice System Guidance");
                expect(JSON.stringify(context.messages)).not.toContain("Valid extension guidance");
                return fauxAssistantMessage("Built-in agent still works.");
              },
            ],
            reports,
          ),
        },
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1" }),
          given.codemode.writeFile({ orgId: "org-1", path: manifestPath, content: manifest }),
          given.codemode.writeFile({ orgId: "org-1", path: extensionPath, content: simpleSource }),
        ],
        steps: ({ then }) => [
          then.assert("invalid artifacts are nonfatal", async ({ runtime }) => {
            expect(await buildExtension(runtime)).toMatchObject({ status: "success" });
            const state = workspace(runtime).stateBackend;
            const artifact = javaScriptModuleArtifactSchema.parse(
              await state.readJson(artifactPath),
            );
            await state.writeFile(artifactPath, JSON.stringify(invalid.change(artifact)));
            const before = compiler.compilations;
            compiler.available = false;
            expect(
              JSON.stringify(
                (await runPrompt(runtime, await createAgent(runtime), "invalid-artifact")).entries,
              ),
            ).toContain("Built-in agent still works.");
            expect(reports).toHaveLength(1);
            expect(errorMessages(reports[0])).toContain("PI_EXTENSION_ARTIFACT_INVALID");
            expect(compiler.compilations).toBe(before);
          }),
        ],
      }),
    );
  });
}

for (const invalid of [
  {
    name: "source activation",
    entries: [extensionPath],
    error: "PI_EXTENSION_BUILD_REQUIRED",
  },
  {
    name: "missing artifact",
    entries: ["./.build/missing.extension.json"],
    error: "PI_EXTENSION_BUILD_REQUIRED",
  },
  {
    name: "path escape",
    entries: ["../outside.extension.json"],
    error: "PI_EXTENSION_INVALID_PATH",
  },
  {
    name: "duplicate activation",
    entries: [artifactPath, artifactPath],
    error: "PI_EXTENSION_DUPLICATE_PATH",
  },
]) {
  test(`${invalid.name} never falls back to source compilation`, async () => {
    const reports: unknown[] = [];
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: invalid.name,
        env: { codemode: { remoteExecutor: createCodemodeNodeExecutor(server) } },
        options: { drain: false },
        piAvailableModels: [{ provider: "faux", modelId: "faux-1", label: "Faux 1" }],
        objects: {
          ...scenarioObjects,
          ...scriptedExtensionAgents(
            [
              (context) => {
                expect(JSON.stringify(context.messages)).toContain("# Backoffice System Guidance");
                return fauxAssistantMessage("No implicit build.");
              },
            ],
            reports,
          ),
        },
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1" }),
          given.codemode.writeFile({
            orgId: "org-1",
            path: extensionPath,
            content: extensionSource,
          }),
          given.codemode.writeFile({
            orgId: "org-1",
            path: manifestPath,
            content: JSON.stringify({ extensions: invalid.entries }),
          }),
        ],
        steps: ({ then }) => [
          then.assert("the compiler is not consulted", async ({ runtime }) => {
            const before = compiler.compilations;
            compiler.available = false;
            expect(
              JSON.stringify(
                (await runPrompt(runtime, await createAgent(runtime), "no-fallback")).entries,
              ),
            ).toContain("No implicit build.");
            expect(reports).toHaveLength(1);
            expect(errorMessages(reports[0])).toContain(invalid.error);
            expect(compiler.compilations).toBe(before);
          }),
        ],
      }),
    );
  });
}

for (const invalid of [
  { name: "non-text result", render: '() => ({ text: "not a section" })' },
  {
    name: "sealed network",
    render: 'async () => await (await fetch("https://example.com")).text()',
  },
  {
    name: "filesystem escape",
    render: 'async ({ env }) => (await env.readTextFile("/etc/passwd")).value',
  },
  { name: "oversized section", render: '() => "a".repeat(65_537)' },
]) {
  test(`precompiled ${invalid.name} remains isolated and cannot brick a session`, async () => {
    const reports: unknown[] = [];
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: invalid.name,
        env: { codemode: { remoteExecutor: createCodemodeNodeExecutor(server) } },
        options: { drain: false },
        piAvailableModels: [{ provider: "faux", modelId: "faux-1", label: "Faux 1" }],
        objects: {
          ...scenarioObjects,
          ...scriptedExtensionAgents(
            [
              (context) => {
                expect(JSON.stringify(context.messages)).toContain("# Backoffice System Guidance");
                return fauxAssistantMessage("Isolated extension failure.");
              },
            ],
            reports,
          ),
        },
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1" }),
          given.codemode.writeFile({ orgId: "org-1", path: manifestPath, content: manifest }),
          given.codemode.writeFile({
            orgId: "org-1",
            path: extensionPath,
            content: `export default { name: "invalid", sections: [{ key: "invalid", render: ${invalid.render} }] };`,
          }),
        ],
        steps: ({ then }) => [
          then.assert(
            "rendering still enforces capabilities and result limits",
            async ({ runtime }) => {
              expect(await buildExtension(runtime)).toMatchObject({ status: "success" });
              compiler.available = false;
              expect(
                JSON.stringify(
                  (await runPrompt(runtime, await createAgent(runtime), "isolated")).entries,
                ),
              ).toContain("Isolated extension failure.");
              expect(reports).toHaveLength(1);
              expect(errorMessages(reports[0])).toContain("PI_EXTENSION_RENDER_FAILED");
            },
          ),
        ],
      }),
    );
  });
}

for (const invalid of [
  {
    name: "transaction API",
    execute: "async (_args, api) => api.commit(() => undefined)",
    error: "PI_EXTENSION_UNSUPPORTED_API: commit",
  },
  {
    name: "tool filesystem escape",
    execute: 'async (_args, api) => api.env.readTextFile("/etc/passwd")',
    error: "PI_EXTENSION_READ_PATH_DENIED",
  },
  {
    name: "tool network escape",
    execute: 'async () => { await fetch("https://example.com"); return {}; }',
    error: "not permitted to access the internet",
  },
  {
    name: "invalid output report",
    execute: 'async (_args, api) => { api.output({ text: "bad" }); return {}; }',
    error: "PI_EXTENSION_INVALID_OUTPUT",
  },
  {
    name: "invalid diagnostic report",
    execute:
      'async (_args, api) => { api.diagnostic({ severity: "made-up", message: "bad" }); return {}; }',
    error: "Invalid option",
  },
  {
    name: "invalid tool result",
    execute: 'async () => ({ content: [{ type: "text", text: 42 }] })',
    error: "Invalid input",
  },
]) {
  test(`workspace ${invalid.name} fails as a tool result without breaking the session`, async () => {
    const reports: unknown[] = [];
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: invalid.name,
        env: { codemode: { remoteExecutor: createCodemodeNodeExecutor(server) } },
        options: { drain: false },
        piAvailableModels: [{ provider: "faux", modelId: "faux-1", label: "Faux 1" }],
        objects: {
          ...scenarioObjects,
          ...scriptedExtensionAgents(
            [
              () => ({
                ...fauxAssistantMessage(""),
                stopReason: "toolUse",
                content: [
                  { type: "toolCall", id: "invalid-tool", name: "isolated_tool", arguments: {} },
                ],
              }),
              (context) => {
                const result = context.messages.find((message) => message.role === "toolResult");
                expect(result).toMatchObject({ role: "toolResult", isError: true });
                expect(JSON.stringify(result).toLowerCase()).toContain(invalid.error.toLowerCase());
                return fauxAssistantMessage("Tool failure handled.");
              },
            ],
            reports,
          ),
        },
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1" }),
          given.codemode.writeFile({ orgId: "org-1", path: manifestPath, content: manifest }),
          given.codemode.writeFile({
            orgId: "org-1",
            path: extensionPath,
            content: `export default { name: "isolated", tools: [{ name: "isolated_tool", description: "Isolated tool", parameters: { type: "object", properties: {} }, execute: ${invalid.execute} }] };`,
          }),
        ],
        steps: ({ then }) => [
          then.assert(
            "only supported capabilities and valid data reach the host",
            async ({ runtime }) => {
              expect(await buildExtension(runtime)).toMatchObject({ status: "success" });
              compiler.available = false;
              const view = await runPrompt(runtime, await createAgent(runtime), "invalid-tool");
              expect(JSON.stringify(view.entries)).toContain("Tool failure handled.");
              expect(reports).toEqual([]);
            },
          ),
        ],
      }),
    );
  });
}

test("hook-only extensions preserve native failure isolation and reject malformed decisions", async () => {
  const reports: unknown[] = [];
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "malformed hook decision",
      env: { codemode: { remoteExecutor: createCodemodeNodeExecutor(server) } },
      options: { drain: false },
      piAvailableModels: [{ provider: "faux", modelId: "faux-1", label: "Faux 1" }],
      objects: {
        ...scenarioObjects,
        ...scriptedExtensionAgents(
          [() => fauxAssistantMessage("Malformed hook did not break the session.")],
          reports,
        ),
      },
      setup: ({ given }) => [
        given.organization.exists({ id: "org-1" }),
        given.codemode.writeFile({ orgId: "org-1", path: manifestPath, content: manifest }),
        given.codemode.writeFile({
          orgId: "org-1",
          path: extensionPath,
          content:
            'export default { name: "hook-only", hooks: [{ task: "pi.generation", handlers: { onYield: () => ({ continue: 42 }) } }] };',
        }),
      ],
      steps: ({ then }) => [
        then.assert(
          "invalid hook results are reported rather than adopted",
          async ({ runtime }) => {
            expect(await buildExtension(runtime)).toMatchObject({ status: "success" });
            compiler.available = false;
            const view = await runPrompt(runtime, await createAgent(runtime), "malformed-hook");
            expect(JSON.stringify(view.entries)).toContain(
              "Malformed hook did not break the session.",
            );
            expect(reports).toHaveLength(1);
            expect(errorMessages(reports[0])).toContain("continue");
          },
        ),
      ],
    }),
  );
});

test("js.build validates CLI inputs and scoped modification authority before compiling", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "build input and authority boundaries",
      env: { codemode: { remoteExecutor: createCodemodeNodeExecutor(server) } },
      setup: ({ given }) => [
        given.organization.exists({ id: "org-1" }),
        given.auth.user({ id: "outsider", email: "outsider@example.test" }),
        given.codemode.writeFile({ orgId: "org-1", path: extensionPath, content: simpleSource }),
      ],
      steps: ({ then }) => [
        then.assert("rejected commands publish nothing", async ({ runtime }) => {
          const before = compiler.compilations;
          const context = workspace(runtime);
          const { bash } = createInteractiveBashHost({ context });
          for (const command of [
            `js.build ${extensionPath}`,
            `js.build ${extensionPath} --target pi-extension --out ${artifactPath}`,
            `js.build ${extensionPath} --out ${artifactPath} --unknown flag`,
            `js.build ${extensionPath} --out /static/escape.module.json`,
            `js.build /workspace/other.js --out ${artifactPath}`,
          ]) {
            const result = await bash.exec(command);
            expect(result.exitCode, command).not.toBe(0);
          }
          const deniedContext = createCodemodeRouteBackedRuntimeContext({
            runtime: runtime.services,
            kernel: new BackofficeKernel(runtime.services),
            execution: createBackofficeUserExecution({ scope, userId: "outsider" }),
            billingOrganizationId: null,
          });
          const denied = await createInteractiveBashHost({ context: deniedContext }).bash.exec(
            `js.build ${extensionPath} --out ${artifactPath}`,
          );
          expect(denied.exitCode).not.toBe(0);
          assert.equal(compiler.compilations, before);
          assert.equal(await context.stateBackend.exists(artifactPath), false);
        }),
      ],
    }),
  );
});
