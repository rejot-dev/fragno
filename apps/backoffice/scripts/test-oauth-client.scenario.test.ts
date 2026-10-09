import { assert, describe, expect, test, vi } from "vitest";

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { createBackofficeUserExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { backofficeOAuthClientCreateResultSchema } from "@/fragno/auth/oauth-client";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { runBackofficeCodemode } from "@/fragno/codemode/execute";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import { InMemoryAppsObject } from "../workers/apps.do";
import { InMemoryAuthObject } from "../workers/auth.do";
import { InMemoryAutomationsObject } from "../workers/automations.do";
import { InMemoryFormsObject } from "../workers/forms.do";
import { InMemoryUploadObject } from "../workers/upload.do";

const scenarioObjects = {
  APPS: (input) => new InMemoryAppsObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const scriptPath = fileURLToPath(new URL("./test-oauth-client.mjs", import.meta.url));

async function listenOnLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return address.port;
}

async function closeScenarioServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function stopOAuthTestProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const closed = once(child, "close");
  child.kill();
  await closed;
}

async function startScenarioAuthHttpServer(ctx: BackofficeScenarioContext) {
  const server = createServer(function dispatchScenarioAuth(request, response) {
    void forwardToScenarioAuth(request, response);
  });
  async function forwardToScenarioAuth(request: IncomingMessage, response: ServerResponse) {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) {
          for (const item of Array.isArray(value) ? value : [value]) {
            headers.append(name, item);
          }
        }
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(chunk as Buffer);
      }
      const result = await ctx.runtime.objects.auth.singleton().http.fetch(
        new Request(`http://${request.headers.host}${request.url}`, {
          method: request.method,
          headers,
          body:
            request.method === "GET" || request.method === "HEAD"
              ? undefined
              : Buffer.concat(chunks).toString("utf8"),
        }),
      );
      response.statusCode = result.status;
      result.headers.forEach((value, name) => {
        if (name !== "set-cookie") {
          response.setHeader(name, value);
        }
      });
      response.setHeader("set-cookie", result.headers.getSetCookie());
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : "Auth test transport failed.");
    }
  }
  const port = await listenOnLoopback(server);
  return { server, origin: `http://127.0.0.1:${port}` };
}

async function createNativeTestClient(
  origin: string,
  redirectUri: string,
  authentication: "none" | "client_secret_basic",
  ctx: BackofficeScenarioContext,
) {
  const signUp = await fetch(`${origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      email: "oauth-local@example.com",
      name: "OAuth local test",
      password: "local-password-123",
    }),
  });
  assert.equal(signUp.status, 200, await signUp.clone().text());
  const cookie = signUp.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert(cookie);
  const grant = await ctx.runtime.objects.auth
    .singleton()
    .commands.grantBackofficeAdminByEmail({ email: "oauth-local@example.com" });
  assert(grant.status === "granted");
  const context = createRouteBackedRuntimeContext({
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution: createBackofficeUserExecution({ scope: { kind: "system" }, userId: grant.userId }),
    billingOrganizationId: null,
  });
  let client: z.output<typeof backofficeOAuthClientCreateResultSchema>;
  if (authentication === "none") {
    assert(context.stateBackend);
    const { bash, commandCallsResult } = createInteractiveBashHost({
      context: { ...context, stateBackend: context.stateBackend },
    });
    const help = await bash.exec("admin.oauth-clients.create --help");
    assert.equal(help.exitCode, 0, help.stderr);
    expect(help.stdout).toContain("--application-type");
    const options = `--name 'Local OAuth PKCE Test' --client-type public --redirect-uri '${redirectUri}' --scope openid --scope profile --scope email`;
    const webLoopback = await bash.exec(`admin.oauth-clients.create ${options} --format json`);
    assert.equal(webLoopback.exitCode, 1);
    const invalidType = await bash.exec(
      `admin.oauth-clients.create ${options} --application-type desktop --format json`,
    );
    assert.equal(invalidType.exitCode, 1);
    const created = await bash.exec(
      `admin.oauth-clients.create ${options} --application-type native --format json`,
    );
    assert.equal(created.exitCode, 0, created.stderr);
    client = backofficeOAuthClientCreateResultSchema.parse(JSON.parse(created.stdout));
    expect(commandCallsResult).toContainEqual(
      expect.objectContaining({ command: "admin.oauth-clients.create", output: "[redacted]" }),
    );
  } else {
    assert(ctx.runtime.env.codemode);
    const created = await runBackofficeCodemode({
      code: `async () => await admin.oauthClientsCreate(${JSON.stringify({ name: "Local OAuth PKCE Test", applicationType: "native", clientType: "confidential", redirectUris: [redirectUri], scopes: ["openid", "profile", "email"] })})`,
      env: ctx.runtime.env.codemode,
      families: runtimeToolFamilies,
      toolContext: createBackofficeToolContext(context),
    });
    assert(!created.error, created.error ?? "Native client creation failed");
    client = backofficeOAuthClientCreateResultSchema.parse(created.result);
    expect(created.toolCalls).toContainEqual(
      expect.objectContaining({
        toolId: "admin.oauth-clients.create",
        status: "success",
        resultSummary: "[redacted]",
      }),
    );
    assert(client.clientSecret !== null);
    expect(JSON.stringify(created.toolCalls)).not.toContain(client.clientSecret);
  }
  const metadata = await fetch(
    `${origin}/api/auth/oauth2/get-client?client_id=${client.clientId}`,
    { headers: { cookie } },
  );
  assert.equal(metadata.status, 200);
  const stored = z
    .object({
      application_type: z.string(),
      token_endpoint_auth_method: z.string(),
      require_pkce: z.boolean(),
      grant_types: z.array(z.string()),
      user_id: z.string(),
    })
    .parse(await metadata.json());
  expect(stored).toEqual({
    application_type: "native",
    token_endpoint_auth_method: authentication,
    require_pkce: true,
    grant_types: ["authorization_code"],
    user_id: grant.userId,
  });
  return { client, cookie };
}

describe("local OAuth client server SQLite scenarios", () => {
  for (const authentication of ["none", "client_secret_basic"] as const) {
    test(`the CLI completes a real PKCE login using ${authentication} and rejects forged/replayed browser state`, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-oauth-client-test-"));
      try {
        await runBackofficeScenario(
          defineBackofficeScenario({
            objects: scenarioObjects,
            name: "local OAuth callback against real Better Auth storage",
            options: { sqliteDataDirectory: directory },
            env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false", SIGN_UP_INVITATIONS_ENABLED: "false" },
            steps: ({ then }) => [
              then.assert(
                "native client provisioning and browser approval complete the CLI flow",
                async (ctx) => {
                  const provider = await startScenarioAuthHttpServer(ctx);
                  try {
                    const reservation = createServer();
                    const port = await listenOnLoopback(reservation);
                    await closeScenarioServer(reservation);
                    const origin = `http://127.0.0.1:${port}`;
                    const { client, cookie } = await createNativeTestClient(
                      provider.origin,
                      `${origin}/callback`,
                      authentication,
                      ctx,
                    );
                    const env = { ...process.env };
                    delete env.OAUTH_CLIENT_SECRET;
                    if (client.clientSecret !== null) {
                      env.OAUTH_CLIENT_SECRET = client.clientSecret;
                    }
                    const child = spawn(
                      process.execPath,
                      [
                        scriptPath,
                        "--client-id",
                        client.clientId,
                        "--backoffice-url",
                        provider.origin,
                        "--port",
                        String(port),
                      ],
                      { env, stdio: "pipe" },
                    );
                    let stdout = "";
                    let stderr = "";
                    child.stdout.on("data", (chunk: Buffer) => {
                      stdout += chunk.toString();
                    });
                    child.stderr.on("data", (chunk: Buffer) => {
                      stderr += chunk.toString();
                    });
                    try {
                      await vi.waitFor(
                        () => {
                          assert.equal(child.exitCode, null, stderr);
                          expect(stdout).toContain(`OAuth client test server: ${origin}`);
                        },
                        { timeout: 10_000 },
                      );
                      const index = await fetch(origin);
                      expect(await index.text()).toContain(`Redirect URI: ${origin}/callback`);
                      const reboundStatus = await new Promise<number>((resolve, reject) => {
                        const request = httpRequest(
                          origin,
                          { headers: { host: "attacker.example" } },
                          (response) => {
                            assert(response.statusCode);
                            response.resume();
                            resolve(response.statusCode);
                          },
                        );
                        request.on("error", reject);
                        request.end();
                      });
                      assert.equal(reboundStatus, 421);
                      const post = await fetch(`${origin}/login`, { method: "POST" });
                      assert.equal(post.status, 405);

                      for (const nonceMatches of [false, true]) {
                        const start = await fetch(`${origin}/login`, { redirect: "manual" });
                        assert.equal(start.status, 302);
                        const location = start.headers.get("location");
                        assert(location);
                        const authorizationUrl = new URL(location);
                        assert.equal(
                          authorizationUrl.searchParams.get("code_challenge_method"),
                          "S256",
                        );
                        if (!nonceMatches) {
                          authorizationUrl.searchParams.set("nonce", "forged-nonce");
                        }
                        const browserCookie = start.headers
                          .getSetCookie()
                          .map((value) => value.split(";")[0])
                          .join("; ");
                        // Node fetch supplies Sec-Fetch-Mode: cors, which makes the provider return
                        // a JSON redirect. Exercise the browser navigation that the CLI actually uses.
                        const authorize = await new Promise<{
                          status: number;
                          location: string | null;
                        }>((resolve, reject) => {
                          const request = httpRequest(
                            authorizationUrl,
                            {
                              headers: {
                                cookie,
                                accept: "text/html",
                                "sec-fetch-mode": "navigate",
                              },
                            },
                            (response) => {
                              assert(response.statusCode);
                              response.resume();
                              resolve({
                                status: response.statusCode,
                                location: response.headers.location ?? null,
                              });
                            },
                          );
                          request.on("error", reject);
                          request.end();
                        });
                        assert.equal(authorize.status, 302);
                        const consentLocation = authorize.location;
                        assert(consentLocation);
                        const consent = await fetch(`${provider.origin}/api/auth/oauth2/consent`, {
                          method: "POST",
                          headers: {
                            "content-type": "application/json",
                            cookie,
                            origin: provider.origin,
                          },
                          body: JSON.stringify({
                            accept: true,
                            oauth_query: new URL(consentLocation, provider.origin).search.slice(1),
                          }),
                        });
                        assert.equal(consent.status, 200, await consent.clone().text());
                        const callback = z.object({ url: z.url() }).parse(await consent.json()).url;
                        const withoutCookie = await fetch(callback);
                        assert.equal(withoutCookie.status, 400);
                        expect(await withoutCookie.text()).toContain("does not match this browser");
                        const forged = new URL(callback);
                        forged.searchParams.set("state", "forged-state");
                        assert.equal(
                          (await fetch(forged, { headers: { cookie: browserCookie } })).status,
                          400,
                        );
                        const completed = await fetch(callback, {
                          headers: { cookie: browserCookie },
                        });
                        const body = await completed.text();
                        if (nonceMatches) {
                          assert.equal(completed.status, 200, body);
                          expect(body).toContain("OAuth login succeeded");
                          expect(body).toContain("oauth-local@example.com");
                          expect(body).toContain("openid profile email");
                          expect(body).not.toContain("access_token");
                          expect(body).not.toContain("id_token");
                          expect(body).not.toContain("client_secret");
                          if (client.clientSecret !== null) {
                            expect(body).not.toContain(client.clientSecret);
                          }
                        } else {
                          assert.equal(completed.status, 400, body);
                          expect(body).toContain("ID token nonce does not match");
                        }
                        assert.equal(
                          (await fetch(callback, { headers: { cookie: browserCookie } })).status,
                          400,
                        );
                      }
                      const registrations = await ctx.runtime.objects.apps
                        .singleton()
                        .commands.listApps({ pageSize: 25, cursor: null });
                      assert(registrations.ok);
                      assert.equal(registrations.value.apps.length, 0);
                    } finally {
                      await stopOAuthTestProcess(child);
                    }
                    expect(stdout).toContain(
                      "OAuth login succeeded; ID token and userinfo verified.",
                    );
                    if (client.clientSecret !== null) {
                      expect(stdout).not.toContain(client.clientSecret);
                      expect(stderr).not.toContain(client.clientSecret);
                    }
                    expect(stderr).not.toContain("access_token");
                  } finally {
                    await closeScenarioServer(provider.server);
                  }
                },
              ),
            ],
          }),
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 30_000);
  }
});
