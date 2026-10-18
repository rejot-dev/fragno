import { assert, expect, test } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

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

test.each(["production", "development"] as const)(
  "the SQLite %s supervisor serves navigation, processes hooks, and recovers without Graft",
  async (mode) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-sqlite-server-"));
    const port = await reserveBackofficeTestPort();
    const origin = `http://127.0.0.1:${port}`;
    const options = {
      entrypoint: new URL("./start-node-processes.mjs", import.meta.url),
      workingDirectory: fileURLToPath(new URL("../..", import.meta.url)),
      origin,
      environment: {
        NODE_ENV: mode,
        HOST: "127.0.0.1",
        PORT: String(port),
        BACKOFFICE_SQLITE_DIR: directory,
        AUTH_ACCESS_TOKEN_SECRET: "sqlite-server-scenario-auth-secret",
        BACKOFFICE_INTERNAL_REQUEST_SECRET: "sqlite-server-scenario-internal-secret",
        DOCS_PUBLIC_BASE_URL: "https://public.example.test/",
        BACKOFFICE_TRUST_PROXY: "loopback",
        SIGN_UP_INVITATIONS_ENABLED: "false",
        AUTH_EMAIL_VERIFICATION_ENABLED: "false",
        CLOUDFLARE_BRIDGE_URL: "http://127.0.0.1:1",
        CLOUDFLARE_BRIDGE_API_KEY: "unused-scenario-bridge-key",
        GRAFT_CONFIG: "/missing-scenario-graft.toml",
        BACKOFFICE_GRAFT_CONTROL_REMOTE_LOG_ID: "",
        FRAGNO_GRAFT_EXTENSION_PATH: "/missing-scenario-graft-extension.so",
        OTEL_SDK_DISABLED: "true",
      } satisfies Record<string, string>,
      readinessPath: "/healthz",
      startupMessages: ["Node Backoffice listening on", "Node Backoffice hook processor started"],
    };
    let server = await startBackofficeServerProcess(options);
    let cookie = "";
    let organizationId: string;
    const { when, then } = createRuntimeScenarioStepBuilders<null>("SQLITE_SERVER_SCENARIO_FAILED");
    try {
      await runRuntimeScenarioSteps({
        name: "SQLite web and hook processor remain a supported serving topology",
        context: null,
        stepFailurePrefix: "SQLITE_SERVER_SCENARIO_STEP_FAILED",
        steps: [
          then(
            "both services start and React Router supports document and client navigation",
            async () => {
              const page = await fetch(`${origin}/backoffice/login`);
              expect(page.status, `${await page.clone().text()}\n${server.readLogs()}`).toBe(200);
              expect(page.headers.get("backoffice-request-id")).toBeTruthy();
              const html = await page.text();
              expect(html).toContain("<!DOCTYPE html>");
              const version = /"version":\s*"([^"]+)"/.exec(html)?.[1];
              assert(version);
              const discovery = new URL("/__manifest", origin);
              discovery.searchParams.set("version", version);
              discovery.searchParams.set("paths", "/backoffice/login,/backoffice/sign-up");
              const manifest = await fetch(discovery);
              expect(manifest.status, await manifest.clone().text()).toBe(200);
              expect(await manifest.json()).toMatchObject({
                "routes/backoffice/login": { path: "backoffice/login" },
                "routes/backoffice/sign-up": { path: "backoffice/sign-up" },
              });
              const data = await fetch(`${origin}/backoffice/login.data`);
              expect(data.status, await data.clone().text()).toBe(200);
              assert(data.body);
              const decoded = await UNSAFE_decodeViaTurboStream(data.body, globalThis);
              await decoded.done;
              expect(decoded.value).toMatchObject({
                "routes/backoffice/login": { data: { authenticated: false, authError: null } },
              });
              const asset = await fetch(`${origin}/favicon.svg`);
              assert(asset.status === 200);
              assert(asset.headers.get("cache-control") === "public, max-age=60");
              expect(await asset.text()).toContain("<svg");
              const publicPage = await sendBackofficeProxyRequest(`${origin}/backoffice/login`, {
                host: "public.example.test",
                "x-forwarded-proto": "https",
                "x-forwarded-host": "attacker.invalid",
              });
              assert(publicPage.status === 200);
              const forged = await sendBackofficeProxyRequest(`${origin}/backoffice/login`, {
                host: "attacker.invalid",
                "x-forwarded-proto": "https",
              });
              assert(forged.status === 421);
            },
          ),
          when(
            "signup is persisted and the separate processor delivers its organization hook",
            async () => {
              const signup = await fetch(`${origin}/api/auth/sign-up/email`, {
                method: "POST",
                headers: { "content-type": "application/json", origin },
                body: JSON.stringify({
                  name: "SQLite Process User",
                  email: "sqlite-process@example.test",
                  password: "password123",
                }),
              });
              expect(signup.status, `${await signup.clone().text()}\n${server.readLogs()}`).toBe(
                200,
              );
              cookie = signup.headers
                .getSetCookie()
                .map((value) => value.split(";")[0])
                .join("; ");
              expect(cookie).not.toBe("");
              for (let attempt = 0; attempt < 100; attempt += 1) {
                const response = await fetch(`${origin}/api/auth/organization/list`, {
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
              throw new Error(`SQLITE_SERVER_ORGANIZATION_HOOK_TIMED_OUT:\n${server.readLogs()}`);
            },
          ),
          when(
            "the supervisor shuts down both services and restarts on the same SQLite store",
            async () => {
              await server.stop();
              expect(server.readLogs()).toContain("Node Backoffice server shutdown complete");
              expect(server.readLogs()).toContain(
                "Node Backoffice hook processor shutdown complete",
              );
              server = await startBackofficeServerProcess(options);
            },
          ),
          then("the original session, organization, and credentials survive restart", async () => {
            const organizations = await fetch(`${origin}/api/auth/organization/list`, {
              headers: { cookie },
            });
            expect(organizations.status, await organizations.clone().text()).toBe(200);
            expect(await organizations.json()).toEqual(
              expect.arrayContaining([expect.objectContaining({ id: organizationId })]),
            );
            const signIn = await fetch(`${origin}/api/auth/sign-in/email`, {
              method: "POST",
              headers: { "content-type": "application/json", origin },
              body: JSON.stringify({
                email: "sqlite-process@example.test",
                password: "password123",
              }),
            });
            expect(signIn.status, await signIn.clone().text()).toBe(200);
          }),
        ],
      });
    } finally {
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
