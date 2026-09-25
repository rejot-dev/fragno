import { assert, test, vi } from "vitest";

import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import express from "express";
import type { ActionFunctionArgs, ServerBuild } from "react-router";

import { createRequestHandler } from "@react-router/express";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import {
  defineBackofficeScenario,
  runBackofficeScenario,
} from "../../app/fragno/automation/scenario";
import { configureNodeBackofficeProxy } from "./node-server-proxy";

async function postNodeProxyAuthRequest(input: {
  port: number;
  path: string;
  headers: Record<string, string>;
  body: Record<string, string>;
}): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: input.port,
        path: input.path,
        method: "POST",
        headers: input.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify(input.body));
  });
}

test("Node proxy accepts public HTTPS and direct localhost or 127.0.0.1 HTTP while rejecting forged origins", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-node-proxy-"));
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "sign in through public HTTPS and direct loopback HTTP hosts",
        options: { sqliteDataDirectory: directory },
        env: { SIGN_UP_INVITATIONS_ENABLED: "false", AUTH_EMAIL_VERIFICATION_ENABLED: "false" },
        steps: ({ then }) => [
          {
            kind: "when",
            type: "node.proxy.signUpAndSignIn",
            label: "POST public and local auth requests and reject forged host and origin headers",
            async run({ runtime }) {
              const build = {
                entry: { module: { default: () => new Response("unused") } },
                routes: {
                  root: { id: "root", module: { default: () => null } },
                  auth: {
                    id: "auth",
                    parentId: "root",
                    path: "api/auth/*",
                    module: {
                      default: () => null,
                      action: ({ request }: ActionFunctionArgs) =>
                        runtime.objects.auth.singleton().http.fetch(request),
                    },
                  },
                },
                assets: { entry: { imports: [], module: "" }, routes: {}, url: "", version: "" },
                publicPath: "/assets/",
                assetsBuildDirectory: "build",
                future: {},
                ssr: true,
                isSpaMode: false,
                prerender: [],
                routeDiscovery: { mode: "initial", manifestPath: "/__manifest" },
              } satisfies ServerBuild;
              const app = express();
              configureNodeBackofficeProxy(app, "https://public.example.test/", "loopback");
              app.use(createRequestHandler({ build, mode: "production" }));
              const server = app.listen(0, "127.0.0.1");
              try {
                await once(server, "listening");
                const address = server.address();
                assert(address && typeof address !== "string");
                const headers = {
                  host: "public.example.test",
                  "x-forwarded-host": "malicious.example.test:443",
                  "x-forwarded-proto": "https",
                  origin: "https://public.example.test",
                  cookie: "csrf-check=1",
                  "content-type": "application/json",
                };
                const signUp = await postNodeProxyAuthRequest({
                  port: address.port,
                  path: "/api/auth/sign-up/email",
                  headers,
                  body: {
                    name: "Proxy User",
                    email: "proxy@example.test",
                    password: "password123",
                  },
                });
                assert.equal(signUp.status, 200, signUp.body);
                const signIn = await postNodeProxyAuthRequest({
                  port: address.port,
                  path: "/api/auth/sign-in/email",
                  headers,
                  body: { email: "proxy@example.test", password: "password123" },
                });
                assert.equal(signIn.status, 200, signIn.body);

                const localHeaders = {
                  host: `localhost:${address.port}`,
                  origin: `http://localhost:${address.port}`,
                  cookie: "csrf-check=1",
                  "content-type": "application/json",
                };
                const localSignUp = await postNodeProxyAuthRequest({
                  port: address.port,
                  path: "/api/auth/sign-up/email",
                  headers: localHeaders,
                  body: {
                    name: "Local User",
                    email: "local@example.test",
                    password: "password123",
                  },
                });
                assert.equal(localSignUp.status, 200, localSignUp.body);
                const localSignIn = await postNodeProxyAuthRequest({
                  port: address.port,
                  path: "/api/auth/sign-in/email",
                  headers: localHeaders,
                  body: { email: "local@example.test", password: "password123" },
                });
                assert.equal(localSignIn.status, 200, localSignIn.body);

                const loopbackIpHeaders = {
                  ...localHeaders,
                  host: `127.0.0.1:${address.port}`,
                  origin: `http://127.0.0.1:${address.port}`,
                };
                const loopbackIpSignIn = await postNodeProxyAuthRequest({
                  port: address.port,
                  path: "/api/auth/sign-in/email",
                  headers: loopbackIpHeaders,
                  body: { email: "local@example.test", password: "password123" },
                });
                assert.equal(loopbackIpSignIn.status, 200, loopbackIpSignIn.body);

                const forgedHost = await postNodeProxyAuthRequest({
                  port: address.port,
                  path: "/api/auth/sign-up/email",
                  headers: { ...headers, host: `127.0.0.1:${address.port}` },
                  body: {
                    name: "Forged Host",
                    email: "forged-host@example.test",
                    password: "password123",
                  },
                });
                assert.equal(forgedHost.status, 421);

                const proxiedLocalhost = await postNodeProxyAuthRequest({
                  port: address.port,
                  path: "/api/auth/sign-in/email",
                  headers: { ...headers, host: `localhost:${address.port}` },
                  body: { email: "local@example.test", password: "password123" },
                });
                assert.equal(proxiedLocalhost.status, 421);

                const httpProxiedLocalhost = await postNodeProxyAuthRequest({
                  port: address.port,
                  path: "/api/auth/sign-in/email",
                  headers: {
                    ...localHeaders,
                    "x-forwarded-proto": "http",
                    "x-forwarded-for": "203.0.113.1",
                  },
                  body: { email: "local@example.test", password: "password123" },
                });
                assert.equal(httpProxiedLocalhost.status, 421);

                const httpProxiedLoopbackIp = await postNodeProxyAuthRequest({
                  port: address.port,
                  path: "/api/auth/sign-in/email",
                  headers: {
                    ...loopbackIpHeaders,
                    "x-forwarded-proto": "http",
                    "x-forwarded-for": "203.0.113.1",
                  },
                  body: { email: "local@example.test", password: "password123" },
                });
                assert.equal(httpProxiedLoopbackIp.status, 421);

                const forgedProto = await postNodeProxyAuthRequest({
                  port: address.port,
                  path: "/api/auth/sign-up/email",
                  headers: { ...headers, "x-forwarded-proto": "http" },
                  body: {
                    name: "Forged Protocol",
                    email: "forged-protocol@example.test",
                    password: "password123",
                  },
                });
                assert.equal(forgedProto.status, 421);

                const forgedOrigin = await postNodeProxyAuthRequest({
                  port: address.port,
                  path: "/api/auth/sign-up/email",
                  headers: { ...headers, origin: "https://malicious.example.test" },
                  body: {
                    name: "Forged Origin",
                    email: "forged-origin@example.test",
                    password: "password123",
                  },
                });
                assert.equal(forgedOrigin.status, 400);
              } finally {
                await new Promise<void>((resolve, reject) =>
                  server.close((error) => (error ? reject(error) : resolve())),
                );
              }
            },
          },
          then.assert(
            "public and local accounts exist in the file-backed auth database",
            async () => {
              const database = new Database(path.join(directory, "auth.sqlite"), {
                readonly: true,
              });
              try {
                assert.deepEqual(database.prepare("select email from user order by email").all(), [
                  { email: "local@example.test" },
                  { email: "proxy@example.test" },
                ]);
              } finally {
                database.close();
              }
            },
          ),
        ],
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
