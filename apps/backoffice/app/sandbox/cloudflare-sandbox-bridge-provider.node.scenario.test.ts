import { afterAll, assert, beforeAll, expect, test, vi } from "vitest";

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { createNodeBackofficeRuntimeConfiguration } from "@/backoffice-runtime/node/node-runtime-env";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";
import { createSandboxRuntime } from "@/fragno/runtime-tools/families/sandbox-runtime";

const scenarioObjects = allLocalObjects;

const apiKey = "sandbox-bridge-scenario-key";
const observedSandboxIds = new Set<string>();
const bridgeOperations: Array<{ operation: string; body: unknown }> = [];
let bridgeUrl: string;

const bridgeServer = createServer((request, response) => {
  void handleSandboxBridgeScenarioRequest(request, response).catch((error: unknown) => {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: String(error), code: "scenario_server_error" }));
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    bridgeServer.once("error", reject);
    bridgeServer.listen(0, "127.0.0.1", () => {
      bridgeServer.off("error", reject);
      resolve();
    });
  });
  const address = bridgeServer.address();
  assert(address && typeof address !== "string");
  bridgeUrl = `http://127.0.0.1:${address.port}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    bridgeServer.close((error) => (error ? reject(error) : resolve()));
  });
});

test("Node Backoffice manages Cloudflare sandboxes through the authenticated bridge", async () => {
  const configuration = createNodeBackofficeRuntimeConfiguration({
    bridgeUrl,
    bridgeApiKey: apiKey,
    env: {},
  });

  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Node sandbox lifecycle through the Cloudflare bridge",
      env: configuration.runtimeEnv,
      createSandboxProviders: configuration.createSandboxProviders,
      setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
      steps: ({ then }) => [
        then.assert("sandbox start, command execution, and stop use the bridge", async (ctx) => {
          const sandbox = createSandboxRuntime({
            lifecycle: ctx.runtime.objects.sandboxManager.forOrg("org-1").commands,
          });

          await expect(
            sandbox.startSandbox({
              id: "node-dev",
              keepAlive: true,
              startupCommand: "true",
              startupTimeoutMs: 5_000,
            }),
          ).resolves.toMatchObject({ id: "node-dev", status: "requested" });
          await ctx.drain();
          await expect(sandbox.listSandboxes()).resolves.toEqual([
            {
              id: "node-dev",
              status: "running",
              image: "workspace",
              instanceType: "lite",
              workspaceSaved: false,
            },
          ]);

          await expect(
            sandbox.executeCommand({
              sandboxId: "node-dev",
              command: "printf node-sandbox",
              timeoutMs: 5_000,
            }),
          ).resolves.toEqual({
            ok: true,
            stdout: "node-sandbox",
            stderr: "",
            exitCode: 0,
          });

          await expect(sandbox.killSandbox({ sandboxId: "node-dev" })).resolves.toEqual({
            sandboxId: "node-dev",
            killed: true,
          });
          await ctx.drain();
          await expect(sandbox.listSandboxes()).resolves.toEqual([
            {
              id: "node-dev",
              status: "stopped",
              image: "workspace",
              instanceType: "lite",
              workspaceSaved: true,
            },
          ]);
        }),
        then.assert("the bridge receives one stable base32 physical sandbox ID", () => {
          expect([...observedSandboxIds]).toHaveLength(1);
          const [physicalSandboxId] = observedSandboxIds;
          expect(physicalSandboxId).toMatch(/^[a-z2-7]{52}$/);
          expect(bridgeOperations).toEqual([
            {
              operation: "start",
              body: {
                source: { kind: "image", image: "workspace" },
                instanceType: "lite",
                leaseExpiresAt: null,
              },
            },
            { operation: "exec", body: { argv: ["sh", "-lc", "true"], timeoutMs: 5_000 } },
            {
              operation: "exec",
              body: { argv: ["sh", "-lc", "printf node-sandbox"], timeoutMs: 5_000 },
            },
            { operation: "snapshot", body: null },
            { operation: "stop", body: null },
          ]);
        }),
      ],
    }),
  );
});

async function handleSandboxBridgeScenarioRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.headers.authorization !== `Bearer ${apiKey}`) {
    sendJson(response, 401, { error: "Unauthorized", code: "unauthorized" });
    return;
  }

  const url = new URL(request.url ?? "/", bridgeUrl);
  const match = /^\/v1\/sandbox\/([a-z2-7]{1,128})(?:\/(start|exec|snapshot))?$/.exec(url.pathname);
  if (!match) {
    sendJson(response, 404, { error: "Not found", code: "not_found" });
    return;
  }
  observedSandboxIds.add(match[1]);
  const operation = request.method === "DELETE" && !match[2] ? "stop" : match[2];
  const rawBody = await readRequestBody(request);
  bridgeOperations.push({
    operation: operation ?? "unknown",
    body: rawBody ? JSON.parse(rawBody) : null,
  });

  switch (operation) {
    case "start":
      sendJson(response, 200, { restoredSnapshot: null });
      return;
    case "stop":
      response.writeHead(204).end();
      return;
    case "exec": {
      const { argv } = JSON.parse(rawBody) as { argv: string[] };
      sendJson(response, 200, {
        status: "exited",
        exitCode: 0,
        stdout: argv[2] === "printf node-sandbox" ? "node-sandbox" : "",
        stderr: "",
      });
      return;
    }
    case "snapshot":
      sendJson(response, 200, { status: "saved", snapshot: { id: "snapshot-1", size: 1024 } });
      return;
    default:
      sendJson(response, 405, { error: "Method not allowed", code: "method_not_allowed" });
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
