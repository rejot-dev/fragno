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
import { createTestMcpServer } from "@fragno-dev/mcp-fragment/testing";

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { InMemoryMcpObject } from "../../../../../workers/mcp.do";

const scope = { kind: "org", orgId: "org-1" } as const;
const clientPath = "/workspace/integrations/tools.js";

let codemodeServer: Awaited<ReturnType<typeof createCodemodeTestServer>>;
beforeAll(async () => {
  // js.build declares Backoffice's Pi SDK dependency, which the test compiler resolves from here.
  codemodeServer = await createCodemodeTestServer(
    (compile) => compile,
    fileURLToPath(new URL("../../../../../", import.meta.url)),
  );
});
afterAll(async () => {
  await codemodeServer?.close();
});

async function terminal(ctx: BackofficeScenarioContext) {
  const context = createCodemodeRouteBackedRuntimeContext({
    emitter: { kind: "caller" },
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution: createBackofficeSystemExecution(scope),
  });
  return (await createInteractiveBashHost({ context })).bash;
}

test("a generated MCP client is imported by codemode, saved modules, and pinned workflows", async () => {
  const mcpServer = createTestMcpServer({
    protocolVersion: "2026-07-28",
    enableJsonResponse: true,
    tools: [
      {
        name: "echo",
        title: "Echo",
        description: "Echo a message.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string", description: "Message to echo." } },
          required: ["text"],
        },
        outputSchema: {
          type: "object",
          properties: { echoed: { type: "string" } },
          required: ["echoed"],
        },
        call: ({ text }) => ({
          content: [{ type: "text", text: String(text) }],
          structuredContent: { echoed: String(text) },
        }),
      },
      {
        name: "refuse",
        description: "Always reports a tool error.",
        inputSchema: { type: "object", properties: {} },
        call: () => ({ isError: true, content: [{ type: "text", text: "Quota exhausted." }] }),
      },
      {
        name: "legacy",
        description: "Publishes a draft-04 schema that cannot be validated.",
        inputSchema: { $schema: "http://json-schema.org/draft-04/schema#", type: "object" },
        call: () => ({ content: [{ type: "text", text: "legacy" }] }),
      },
    ],
  });
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "generated MCP client",
        objects: {
          ...allLocalObjects,
          MCP: (options) =>
            new InMemoryMcpObject({
              ...options,
              fetch: async (input, init) => await mcpServer.fetch(new Request(input, init)),
            }),
        },
        env: { codemode: createCodemodeNodeExecutor(codemodeServer) },
        // The second workflow instance runs the edited client and fails.
        options: { allowErroredWorkflows: true },
        setup: ({ given }) => [
          given.organization.exists({ id: scope.orgId }),
          given.codemode.writeFile({
            orgId: scope.orgId,
            path: "/workspace/notes.js",
            content: "export const handWritten = true;",
          }),
          given.codemode.writeFile({
            orgId: scope.orgId,
            path: "/workspace/scripts/echo.js",
            content: `import { echo } from "../integrations/tools.js";
const result = await echo({ text: "saved" });
if (!result.isError) console.log(result.structuredContent.echoed);`,
          }),
          given.codemode.writeFile({
            orgId: scope.orgId,
            path: "/workspace/automations/echo-client.workflow.js",
            content: `defineWorkflow({ name: "echo-client" }, async (_event, step) => {
  const echoed = async (text) => {
    const { echo } = await import(${JSON.stringify(clientPath)});
    return (await echo({ text })).structuredContent;
  };
  const first = await step.do("first", async () => await echoed("first"));
  await step.sleep("pause", "1 minute");
  const second = await step.do("second", async () => await echoed("second"));
  return { first, second };
});`,
          }),
          given.codemode.writeFile({
            orgId: scope.orgId,
            path: "/workspace/scripts/exports.js",
            content: `import * as tools from "../integrations/tools.js";
console.log(Object.keys(tools).join(","));`,
          }),
        ],
        steps: ({ when, then }) => [
          when.codemode.run({
            scope,
            code: `async () => await integrations.setup({
              connectionId: "mcp#tools",
              kind: "input",
              input: { type: "none", name: "Tools", endpointUrl: "https://tools.provider.test/mcp" },
            })`,
          }),
          then.assert("the client exports one function per published action", async (ctx) => {
            // Tools arrive through the source's background refresh.
            await ctx.drain();
            const generated = await (
              await terminal(ctx)
            ).exec(`integrations.generateClient --connection-id 'mcp#tools' --out ${clientPath}`);
            assert.equal(generated.exitCode, 0, generated.stderr);
            expect(generated.stdout).toBe(
              `${clientPath}\necho\techo\nrefuse\trefuse\nlegacy\tlegacy\n`,
            );
          }),
          then.assert(
            "inline codemode imports the client and calls the connection",
            async (ctx) => {
              const run = await ctx.runCodemode({
                scope,
                code: `async () => {
                const { echo, refuse, legacy } = await import(${JSON.stringify(clientPath)});
                return {
                  echoed: await echo({ text: "inline" }),
                  refused: await refuse({}),
                  // The generated function opts in to the unchecked action for its caller.
                  legacy: await legacy({}),
                };
              }`,
                assertToolCalls: [
                  "integrations.execute",
                  "integrations.execute",
                  "integrations.execute",
                ],
              });
              expect(run.result).toEqual({
                echoed: {
                  isError: false,
                  content: [{ type: "text", text: "inline" }],
                  structuredContent: { echoed: "inline" },
                },
                refused: {
                  isError: true,
                  content: [{ type: "text", text: "Quota exhausted." }],
                  structuredContent: null,
                },
                legacy: {
                  isError: false,
                  content: [{ type: "text", text: "legacy" }],
                  structuredContent: null,
                },
              });
            },
          ),
          then.assert(
            "saved modules import the client relatively, as source and as a built module",
            async (ctx) => {
              const bash = await terminal(ctx);
              const source = await bash.exec("js.run /workspace/scripts/echo.js --format json");
              assert.equal(source.exitCode, 0, source.stdout);
              expect(JSON.parse(source.stdout)).toMatchObject({
                status: "success",
                logs: [{ channel: "log", text: "saved" }],
              });
              // Built module initialization cannot call tools, so the build only proves the client is bundled.
              const built = await bash.exec(
                "js.build /workspace/scripts/exports.js --out /workspace/.build/exports.module.json",
              );
              assert.equal(built.exitCode, 0, built.stderr);
              const build = await bash.exec(
                "js.run /workspace/.build/exports.module.json --format json",
              );
              assert.equal(build.exitCode, 0, build.stdout);
              expect(JSON.parse(build.stdout)).toMatchObject({
                status: "success",
                logs: [{ channel: "log", text: "echo,legacy,refuse" }],
              });
            },
          ),
          then.assert(
            "regeneration replaces generated clients but never a hand-written module",
            async (ctx) => {
              const bash = await terminal(ctx);
              const regenerated = await bash.exec(
                `integrations.generateClient --connection-id 'mcp#tools' --out ${clientPath}`,
              );
              assert.equal(regenerated.exitCode, 0, regenerated.stderr);
              const refused = await bash.exec(
                "integrations.generateClient --connection-id 'mcp#tools' --out /workspace/notes.js",
              );
              assert.notEqual(refused.exitCode, 0);
              expect(refused.stderr).toContain("was not generated by integrations.generateClient");
              assert(
                (await bash.exec("cat /workspace/notes.js")).stdout ===
                  "export const handWritten = true;",
              );
            },
          ),
          then.assert(
            "imports that cannot be loaded are refused before anything runs",
            async (ctx) => {
              await expect(
                ctx.runCodemode({
                  scope,
                  code: 'async () => await import("/workspace/integrations/missing.js")',
                }),
              ).rejects.toThrow("'/workspace/integrations/missing.js' cannot be read");
            },
          ),
          when.codemode.run({
            scope,
            code: `async () => await workflow.createInstance({
              path: "/workspace/automations/echo-client.workflow.js",
              instanceId: "echo-client-1",
            })`,
          }),
          then.workflow.steps({ remoteWorkflowName: "echo-client", include: ["first"] }),
          // The instance pinned the client when it was created; this edit reaches later instances only.
          when.codemode.run({
            scope,
            code: `async () => await state.writeFile({
              path: ${JSON.stringify(clientPath)},
              content: 'export const echo = () => { throw new Error("edited after scheduling"); };',
            })`,
          }),
          when.time.advance("2 minutes"),
          then.workflow.instance({
            remoteWorkflowName: "echo-client",
            status: "complete",
            output: { first: { echoed: "first" }, second: { echoed: "second" } },
          }),
          when.codemode.run({
            scope,
            code: `async () => await workflow.createInstance({
              path: "/workspace/automations/echo-client.workflow.js",
              instanceId: "echo-client-2",
            })`,
          }),
          when.time.advance("2 minutes"),
          then.workflow.instance({ remoteWorkflowName: "echo-client", status: "errored" }),
        ],
      }),
    );
  } finally {
    await mcpServer.close();
  }
});
