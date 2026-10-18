import { afterAll, beforeAll, expect, test, assert } from "vitest";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createNodeRuntimeScenarioEnvironment } from "@fragno-private/backoffice-node-runtime/node-runtime-scenario";
import {
  createRuntimeScenarioStepBuilders,
  runRuntimeScenarioSteps,
} from "@fragno-private/backoffice-node-runtime/runtime-scenario";
import { UNSAFE_decodeViaTurboStream } from "react-router";

import {
  reserveBackofficeTestPort,
  sendBackofficeProxyRequest,
  startBackofficeServerProcess,
} from "../server/fixtures/node-server-process";

let environment: Awaited<ReturnType<typeof createNodeRuntimeScenarioEnvironment>>;
let localDirectory: string;
beforeAll(async () => {
  environment = await createNodeRuntimeScenarioEnvironment();
  localDirectory = await mkdtemp(path.join(os.tmpdir(), "backoffice-development-process-"));
});
afterAll(async () => {
  await environment.cleanup();
  await rm(localDirectory, { recursive: true, force: true });
});

async function startGraftBackofficeProcess(
  storage: ReturnType<typeof environment.createStorage> | null,
  workingDirectory: string,
  supervised: boolean,
) {
  const [port, internalPort] = await Promise.all([
    reserveBackofficeTestPort(),
    reserveBackofficeTestPort(),
  ]);
  const origin = `http://127.0.0.1:${port}`;
  // Node fixture values are independent of Wrangler's generated environment literals.
  const environmentOverrides: Record<string, string> = {
    NODE_ENV: storage === null ? "development" : "production",
    HOST: "127.0.0.1",
    PORT: String(port),
    BACKOFFICE_NODE_INTERNAL_HOST: "127.0.0.1",
    BACKOFFICE_NODE_INTERNAL_PORT: String(internalPort),
    BACKOFFICE_NODE_APPLICATION_ORIGIN: origin,
    BACKOFFICE_NODE_INTERNAL_ORIGIN: `http://127.0.0.1:${internalPort}`,
    GRAFT_CONFIG: storage?.configPath ?? "",
    BACKOFFICE_GRAFT_CONTROL_REMOTE_LOG_ID: storage?.controlRemoteLogId ?? "",
    AUTH_ACCESS_TOKEN_SECRET: "backoffice-process-scenario-auth-secret",
    BACKOFFICE_INTERNAL_REQUEST_SECRET: "backoffice-process-scenario-internal-secret",
    DOCS_PUBLIC_BASE_URL: "https://public.example.test/",
    BACKOFFICE_TRUST_PROXY: "loopback",
    SIGN_UP_INVITATIONS_ENABLED: "false",
    AUTH_EMAIL_VERIFICATION_ENABLED: "false",
    CLOUDFLARE_BRIDGE_URL: "http://127.0.0.1:1",
    CLOUDFLARE_BRIDGE_API_KEY: "unused-scenario-bridge-key",
    OTEL_SDK_DISABLED: "true",
  };
  return await startBackofficeServerProcess({
    entrypoint: new URL(
      supervised ? "./start-graft-processes.mjs" : "../../build-graft/backoffice-node.mjs",
      import.meta.url,
    ),
    workingDirectory,
    origin,
    environment: environmentOverrides,
    readinessPath: "/_runtime/ready",
    startupMessages: supervised ? ["Node Backoffice supervisor started server"] : [],
  });
}

test.each(["production", "development", "supervised"] as const)(
  "the single %s entrypoint serves React Router, owns hooks, enforces proxy origins, and restarts",
  async (mode) => {
    const supervised = mode === "supervised";
    const storage = mode === "development" ? null : environment.createStorage();
    const workingDirectory =
      mode !== "development"
        ? fileURLToPath(new URL("../..", import.meta.url))
        : await mkdtemp(path.join(localDirectory, "store-"));
    let server = await startGraftBackofficeProcess(storage, workingDirectory, supervised);
    const originalLocalId =
      storage === null
        ? await readFile(path.join(workingDirectory, ".backoffice-graft/control-log-id"), "utf8")
        : null;
    let cookie = "";
    let organizationId: string;
    let manifestVersion: string;
    const { when, then } = createRuntimeScenarioStepBuilders<null>(
      "BACKOFFICE_PROCESS_SCENARIO_FAILED",
    );
    try {
      await runRuntimeScenarioSteps({
        name: "one serving process replaces web and hook processor",
        context: null,
        stepFailurePrefix: "BACKOFFICE_PROCESS_SCENARIO_STEP_FAILED",
        steps: [
          then(
            "the real React Router build renders and static assets retain their cache policy",
            async () => {
              const page = await fetch(`${server.origin}/backoffice/login`);
              expect(page.status, `${await page.clone().text()}\n${server.readLogs()}`).toBe(200);
              expect(page.headers.get("backoffice-request-id")).toBeTruthy();
              const html = await page.text();
              expect(html).toContain("<!DOCTYPE html>");
              const version = /"version":\s*"([^"]+)"/.exec(html)?.[1];
              assert(version, "The SSR document must expose its route manifest version");
              manifestVersion = version;
              const asset = await fetch(`${server.origin}/favicon.svg`);
              assert(asset.status === 200);
              assert(asset.headers.get("cache-control") === "public, max-age=60");
              expect(await asset.text()).toContain("<svg");
            },
          ),
          then("client navigation discovers routes and loads single-fetch data", async () => {
            const discovery = new URL("/__manifest", server.origin);
            discovery.searchParams.set("version", manifestVersion);
            discovery.searchParams.set("paths", "/backoffice/login,/backoffice/sign-up");
            const manifest = await fetch(discovery);
            expect(manifest.status, `${await manifest.clone().text()}\n${server.readLogs()}`).toBe(
              200,
            );
            expect(await manifest.json()).toMatchObject({
              "routes/backoffice/login": { path: "backoffice/login" },
              "routes/backoffice/sign-up": { path: "backoffice/sign-up" },
            });
            const data = await fetch(`${server.origin}/backoffice/login.data`);
            expect(data.status, `${await data.clone().text()}\n${server.readLogs()}`).toBe(200);
            expect(data.headers.get("content-type")).toContain("text/x-script");
            assert(data.body);
            const decoded = await UNSAFE_decodeViaTurboStream(data.body, globalThis);
            await decoded.done;
            expect(decoded.value).toMatchObject({
              "routes/backoffice/login": {
                data: { authenticated: false, bootstrapError: null, authError: null },
              },
            });
          }),
          then(
            "readiness is public but peer routes are not; public HTTPS cannot be forged",
            async () => {
              const health = await fetch(`${server.origin}/healthz`, {
                headers: { host: "health-probe.invalid", "x-forwarded-for": "203.0.113.1" },
              });
              assert((await health.text()) === "ok\n");
              assert((await fetch(`${server.origin}/_runtime/not-public`)).status === 404);
              const publicPage = await sendBackofficeProxyRequest(
                `${server.origin}/backoffice/login`,
                {
                  host: "public.example.test",
                  "x-forwarded-proto": "https",
                  "x-forwarded-host": "attacker.invalid",
                },
              );
              assert(publicPage.status === 200);
              const forged = await sendBackofficeProxyRequest(`${server.origin}/backoffice/login`, {
                host: "attacker.invalid",
                "x-forwarded-proto": "https",
              });
              assert(forged.status === 421);
              const forwardedLoopback = await fetch(`${server.origin}/backoffice/login`, {
                headers: {
                  "x-forwarded-proto": "http",
                  "x-forwarded-for": "203.0.113.1",
                },
              });
              assert(forwardedLoopback.status === 421);
            },
          ),
          when(
            "register through React Router and let the same process deliver the durable Auth hook",
            async () => {
              const response = await fetch(`${server.origin}/api/auth/sign-up/email`, {
                method: "POST",
                headers: { "content-type": "application/json", origin: server.origin },
                body: JSON.stringify({
                  name: "Process User",
                  email: "process@example.test",
                  password: "password123",
                }),
              });
              expect(response.status, await response.clone().text()).toBe(200);
              cookie = response.headers
                .getSetCookie()
                .map((value) => value.split(";")[0])
                .join("; ");
              expect(cookie).not.toBe("");
              for (let attempt = 0; attempt < 100; attempt += 1) {
                const response = await fetch(`${server.origin}/api/auth/organization/list`, {
                  headers: { cookie },
                });
                expect(response.status, await response.clone().text()).toBe(200);
                const organizations = (await response.json()) as { id: string }[];
                if (organizations.length > 0) {
                  organizationId = organizations[0].id;
                  return;
                }
                await delay(50);
              }
              throw new Error("BACKOFFICE_PROCESS_ORGANIZATION_HOOK_TIMED_OUT");
            },
          ),
          when("stop the only serving process and start a new incarnation", async () => {
            await server.stop();
            if (storage === null) {
              await rm(path.join(workingDirectory, ".backoffice-graft/cache"), { recursive: true });
            }
            server = await startGraftBackofficeProcess(storage, workingDirectory, supervised);
          }),
          then(
            "the session and organization recover from Graft without a separate processor",
            async () => {
              if (storage === null) {
                expect(
                  await readFile(
                    path.join(workingDirectory, ".backoffice-graft/control-log-id"),
                    "utf8",
                  ),
                ).toBe(originalLocalId);
              }
              const response = await fetch(`${server.origin}/api/auth/organization/list`, {
                headers: { cookie },
              });
              expect(response.status, await response.clone().text()).toBe(200);
              expect(await response.json()).toEqual(
                expect.arrayContaining([expect.objectContaining({ id: organizationId })]),
              );
              const signIn = await fetch(`${server.origin}/api/auth/sign-in/email`, {
                method: "POST",
                headers: { "content-type": "application/json", origin: server.origin },
                body: JSON.stringify({ email: "process@example.test", password: "password123" }),
              });
              expect(signIn.status, await signIn.clone().text()).toBe(200);
            },
          ),
        ],
      });
    } finally {
      await server.stop();
    }
  },
  30_000,
);
