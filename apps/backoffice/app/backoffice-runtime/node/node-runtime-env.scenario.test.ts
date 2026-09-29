import { beforeAll, afterAll, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { createCodemodeTestServer } from "@fragno-dev/codemode/testing/codemode-test-server";

import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";

import { createNodeBackofficeRuntimeConfiguration } from "./node-runtime-env";

let server: Awaited<ReturnType<typeof createCodemodeTestServer>>;
beforeAll(async () => {
  server = await createCodemodeTestServer();
});
afterAll(async () => {
  await server?.close();
});

test("Node production codemode uses the bridge WebSocket and compiler HTTP APIs", async () => {
  const { runtimeEnv: env, workerTypeChecker } = createNodeBackofficeRuntimeConfiguration({
    bridgeUrl: server.url,
    bridgeApiKey: server.apiKey,
    env: {},
  });
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "Node-authoritative state across separate WebSocket activations",
      env,
      setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
      steps: ({ when, then }) => [
        when.codemode.run({
          orgId: "org-1",
          code: `async () => {
        await context.current.store.set({ key: "remote-state", value: "saved" });
        return await context.getCurrentScope();
      }`,
        }),
        when.codemode.run({
          orgId: "org-1",
          code: `async () => await context.current.store.get({ key: "remote-state" })`,
        }),
        then.assert("SQLite-backed state survives executor replacement", (ctx) => {
          expect(ctx.codemodeRuns[0].result.result).toEqual({ kind: "org", orgId: "org-1" });
          expect(ctx.codemodeRuns[1].result).toMatchObject({
            result: { value: "saved" },
            logs: [],
          });
          expect(ctx.codemodeRuns[0].result.toolCalls).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ toolName: "set", status: "success" }),
            ]),
          );
        }),
        then.assert("TypeScript checking uses the bridge HTTP API", async () => {
          const result = await workerTypeChecker({
            files: [
              {
                path: "workspace/example.js",
                read: async () => "const value = 42;",
              },
            ],
            sourcePaths: ["workspace/example.js"],
          });
          expect(result).toEqual({ diagnostics: [] });
        }),
      ],
    }),
  );
});
