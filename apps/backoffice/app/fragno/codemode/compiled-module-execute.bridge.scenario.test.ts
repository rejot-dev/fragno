import { afterAll, beforeAll, assert, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { once } from "node:events";
import { createServer, createConnection, type Socket } from "node:net";

import { CODEMODE_LIMITS } from "@fragno-dev/codemode/codemode-limits";
import { createCodemodeNodeExecutor } from "@fragno-dev/codemode/remote/codemode-node-executor";
import { createCodemodeTestServer } from "@fragno-dev/codemode/testing/codemode-test-server";

import { createBackofficeServiceExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { runBackofficeCompiledModule } from "./compiled-module-execute";

let server: Awaited<ReturnType<typeof createCodemodeTestServer>>;
beforeAll(async () => {
  server = await createCodemodeTestServer();
});
afterAll(async () => {
  await server?.close();
});

for (const interruption of ["parent cancellation", "activation deadline"] as const) {
  test(`compiled module ${interruption} bounds draining while retaining an in-flight workspace read`, async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: `bounded module drain: ${interruption}`,
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1" }),
          given.codemode.writeFile({
            orgId: "org-1",
            path: "/workspace/guidance.txt",
            content: "Late workspace guidance",
          }),
        ],
        steps: ({ then }) => [
          then.assert(
            "cancellation finishes before the provider is released",
            async ({ runtime }) => {
              const context = createCodemodeRouteBackedRuntimeContext({
                runtime: runtime.services,
                kernel: new BackofficeKernel(runtime.services),
                execution: createBackofficeServiceExecution({
                  scope: { kind: "org", orgId: "org-1" },
                  service: { type: "automation", id: "drain-check" },
                }),
                billingOrganizationId: null,
              });
              let releaseRead!: () => void;
              const blocked = new Promise<void>((resolve) => {
                releaseRead = resolve;
              });
              let notifyReadStarted!: () => void;
              const readStarted = new Promise<void>((resolve) => {
                notifyReadStarted = resolve;
              });
              let notifyReadSettled!: () => void;
              const readSettled = new Promise<void>((resolve) => {
                notifyReadSettled = resolve;
              });
              let settled = false;
              const cancellation = new AbortController();
              const execution = runBackofficeCompiledModule({
                bundle: {
                  mainModule: "script.js",
                  modules: { "script.js": "export default {};" },
                  runtime: {
                    compatibilityDate: "2026-05-07",
                    compatibilityFlags: ["nodejs_compat"],
                  },
                },
                invocation: 'async () => await workspace.readTextFile("/workspace/guidance.txt")',
                input: null,
                providers: [
                  {
                    name: "workspace",
                    fns: {
                      readTextFile: async () => {
                        notifyReadStarted();
                        await blocked;
                        try {
                          return await context.stateBackend.readFile("/workspace/guidance.txt");
                        } finally {
                          settled = true;
                          notifyReadSettled();
                        }
                      },
                    },
                  },
                ],
                env: { remoteExecutor: createCodemodeNodeExecutor(server) },
                signal: cancellation.signal,
              });
              const outcome = execution.then(
                () => ({ error: null }),
                (error: unknown) => ({
                  error: error instanceof Error ? error.message : String(error),
                }),
              );
              let watchdog: ReturnType<typeof setTimeout> | null = null;
              try {
                await readStarted;
                const interruptedAt = Date.now();
                if (interruption === "parent cancellation") {
                  cancellation.abort(new Error("Section rendering cancelled"));
                }
                const result = await Promise.race([
                  outcome,
                  new Promise<never>((_resolve, reject) => {
                    watchdog = setTimeout(
                      () => reject(new Error("Caller waited indefinitely for the workspace read")),
                      (interruption === "parent cancellation"
                        ? 0
                        : CODEMODE_LIMITS.connectTimeoutMs + 10_000) +
                        CODEMODE_LIMITS.hostDrainTimeoutMs +
                        2_000,
                    );
                  }),
                ]);
                expect(result.error).toContain(
                  interruption === "parent cancellation"
                    ? "Section rendering cancelled"
                    : "CODEMODE_HOST_DRAIN_TIMED_OUT",
                );
                assert.equal(settled, false);
                assert(
                  Date.now() - interruptedAt <
                    (interruption === "parent cancellation"
                      ? 0
                      : CODEMODE_LIMITS.connectTimeoutMs + 10_000) +
                      CODEMODE_LIMITS.hostDrainTimeoutMs +
                      2_000,
                );
              } finally {
                if (watchdog !== null) {
                  clearTimeout(watchdog);
                }
                releaseRead();
                await readSettled;
                await outcome;
              }
              assert.equal(settled, true);
            },
          ),
        ],
      }),
    );
  }, 35_000);
}

test("remote compiled execution keeps its full guest timeout after a delayed WebSocket connection", async () => {
  const upstream = new URL(server.url);
  const sockets = new Set<Socket>();
  const delays = new Set<ReturnType<typeof setTimeout>>();
  const proxy = createServer((socket) => {
    sockets.add(socket);
    socket.pause();
    const timer = setTimeout(() => {
      delays.delete(timer);
      if (socket.destroyed) {
        return;
      }
      const bridge = createConnection({ host: upstream.hostname, port: Number(upstream.port) });
      sockets.add(bridge);
      socket.on("error", () => bridge.destroy());
      bridge.on("error", () => socket.destroy());
      socket.on("close", () => bridge.destroy());
      bridge.on("close", () => socket.destroy());
      bridge.once("connect", () => {
        socket.pipe(bridge).pipe(socket);
        socket.resume();
      });
    }, 2_000);
    delays.add(timer);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();
  assert(address !== null && typeof address !== "string");
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "remote connection budget is independent of execution budget",
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1" }),
          given.codemode.writeFile({
            orgId: "org-1",
            path: "/workspace/guidance.txt",
            content: "Guidance after valid guest work",
          }),
        ],
        steps: ({ then }) => [
          then.assert(
            "two seconds connecting plus nine seconds of guest work completes",
            async ({ runtime }) => {
              const context = createCodemodeRouteBackedRuntimeContext({
                runtime: runtime.services,
                kernel: new BackofficeKernel(runtime.services),
                execution: createBackofficeServiceExecution({
                  scope: { kind: "org", orgId: "org-1" },
                  service: { type: "automation", id: "connection-check" },
                }),
                billingOrganizationId: null,
              });
              const result = await runBackofficeCompiledModule({
                bundle: {
                  mainModule: "script.js",
                  modules: { "script.js": "export default {};" },
                  runtime: {
                    compatibilityDate: "2026-05-07",
                    compatibilityFlags: ["nodejs_compat"],
                  },
                },
                invocation: 'async () => await workspace.readTextFile("/workspace/guidance.txt")',
                input: null,
                providers: [
                  {
                    name: "workspace",
                    fns: {
                      readTextFile: async () => {
                        await new Promise<void>((resolve) => setTimeout(resolve, 9_000));
                        return await context.stateBackend.readFile("/workspace/guidance.txt");
                      },
                    },
                  },
                ],
                env: {
                  remoteExecutor: createCodemodeNodeExecutor({
                    url: `http://127.0.0.1:${address.port}`,
                    apiKey: server.apiKey,
                  }),
                },
                signal: null,
              });
              expect(result).toBe("Guidance after valid guest work");
            },
          ),
        ],
      }),
    );
  } finally {
    for (const timer of delays) {
      clearTimeout(timer);
    }
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) =>
      proxy.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 30_000);
