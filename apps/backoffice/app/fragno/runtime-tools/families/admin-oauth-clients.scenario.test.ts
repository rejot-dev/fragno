import { assert, describe, expect, test, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import {
  createBackofficeUserExecution,
  type BackofficeContextScope,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
import {
  backofficeOAuthClientCreateResultSchema,
  backofficeOAuthClientPageSchema,
  type BackofficeOAuthClientCreateInput,
} from "@/fragno/auth/oauth-client";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
  type BackofficeScenarioDefinition,
} from "@/fragno/automation/scenario";
import { setScenarioAuthUserRole } from "@/fragno/automation/scenario-auth";
import { runBackofficeCodemode } from "@/fragno/codemode/execute";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { executeBackofficeRuntimeTool } from "@/fragno/runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import { InMemoryApiObject } from "../../../../workers/api.do";
import { InMemoryAppInstallationsObject } from "../../../../workers/app-installations.do";
import { InMemoryAppsObject } from "../../../../workers/apps.do";
import { InMemoryAuthObject } from "../../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../../workers/automations.do";
import { InMemoryFormsObject } from "../../../../workers/forms.do";
import { InMemoryOtpObject } from "../../../../workers/otp.do";
import { InMemoryUploadObject } from "../../../../workers/upload.do";
import { adminAppsRuntimeTools } from "./admin-apps";
import { adminOAuthClientsRuntimeTools } from "./admin-oauth-clients";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  APPS: (input) => new InMemoryAppsObject(input),
  APP_INSTALLATIONS: (input) => new InMemoryAppInstallationsObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  OTP: (input) => new InMemoryOtpObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const clientInput = {
  name: "Accounting",
  redirectUris: ["https://accounting.example/callback"],
  scopes: ["openid", "profile", "email", "offline_access"],
} satisfies Omit<BackofficeOAuthClientCreateInput, "clientType" | "applicationType">;

function oauthAdminContext(
  ctx: BackofficeScenarioContext,
  userId: string,
  scope: BackofficeContextScope = { kind: "system" },
) {
  return createRouteBackedRuntimeContext({
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution: createBackofficeUserExecution({ scope, userId }),
    billingOrganizationId: null,
  });
}

function oauthAuthRequest(
  ctx: BackofficeScenarioContext,
  path: string,
  cookie: string,
  body?: unknown,
) {
  return ctx.runtime.objects.auth.singleton().http.fetch(
    new Request(`https://backoffice.example/api/auth${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: "https://backoffice.example",
        cookie,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function runOAuthAdminSqliteScenario<TVars extends Record<string, unknown>>(
  scenario: BackofficeScenarioDefinition<TVars>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-admin-oauth-"));
  try {
    await runBackofficeScenario({
      ...scenario,
      options: { ...scenario.options, sqliteDataDirectory: directory },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function authorizeOAuthClient(
  ctx: BackofficeScenarioContext,
  cookie: string,
  clientId: string,
): Promise<{ code: string; codeVerifier: string }> {
  const codeVerifier = "v".repeat(64);
  const challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)),
  ).toString("base64url");
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: clientInput.redirectUris[0],
    response_type: "code",
    scope: clientInput.scopes.join(" "),
    state: "accounting-login",
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "consent",
  });
  const authorization = await oauthAuthRequest(ctx, `/oauth2/authorize?${query}`, cookie);
  assert.equal(authorization.status, 302, await authorization.clone().text());
  const location = authorization.headers.get("location");
  assert(location);
  const approved = await oauthAuthRequest(ctx, "/oauth2/consent", cookie, {
    accept: true,
    oauth_query: new URL(location, "https://backoffice.example").search.slice(1),
  });
  assert.equal(approved.status, 200, await approved.clone().text());
  const redirect = z.object({ url: z.string() }).parse(await approved.json());
  const code = new URL(redirect.url).searchParams.get("code");
  assert(code);
  return { code, codeVerifier };
}

const clientMetadataSchema = z.object({
  client_id: z.string(),
  client_name: z.string(),
  user_id: z.string(),
  redirect_uris: z.array(z.string()),
  scope: z.string(),
  token_endpoint_auth_method: z.string(),
  application_type: z.enum(["web", "native"]),
  require_pkce: z.boolean(),
  grant_types: z.array(z.string()),
});

async function promoteOAuthAdministrator(
  ctx: BackofficeScenarioContext,
  email: string,
): Promise<string> {
  const result = await ctx.runtime.objects.auth
    .singleton()
    .commands.grantBackofficeAdminByEmail({ email });
  assert(result.status === "granted" || result.status === "already_admin");
  return result.userId;
}

describe("admin OAuth client SQLite scenarios", () => {
  test.each([
    ["admin", "admin"],
    ["context.current.admin", "current:admin"],
  ])(
    "%s returns credentials without leaking them into Codemode call metadata",
    async (provider, providerName) => {
      await runOAuthAdminSqliteScenario(
        defineBackofficeScenario({
          objects: scenarioObjects,
          name: "OAuth credential redaction across direct and scoped Codemode",
          setup: ({ given }) => [given.auth.user({ id: "admin-1", role: "admin" })],
          steps: ({ then }) => [
            then.assert("credentials reach the caller but never the tool records", async (ctx) => {
              assert(ctx.runtime.env.codemode);
              const result = await runBackofficeCodemode({
                code: `async () => await ${provider}.oauthClientsCreate(${JSON.stringify(clientInput)})`,
                env: ctx.runtime.env.codemode,
                families: runtimeToolFamilies,
                toolContext: createBackofficeToolContext(oauthAdminContext(ctx, "admin-1")),
              });
              assert(!result.error, result.error ?? "OAuth provisioning failed");
              const created = backofficeOAuthClientCreateResultSchema.parse(result.result);
              assert(created.clientType === "confidential");
              assert(created.clientSecret.length > 0);
              assert(
                await ctx.runtime.objects.auth
                  .singleton()
                  .commands.hasOAuthClient({ clientId: created.clientId }),
              );
              expect(result.toolCalls).toEqual([
                expect.objectContaining({
                  providerName,
                  toolId: "admin.oauth-clients.create",
                  status: "success",
                  resultSummary: "[redacted]",
                }),
              ]);
              expect(JSON.stringify(result.toolCalls)).not.toContain(created.clientSecret);
              const listed = await runBackofficeCodemode({
                code: `async () => await ${provider}.oauthClientsList({})`,
                env: ctx.runtime.env.codemode,
                families: runtimeToolFamilies,
                toolContext: createBackofficeToolContext(oauthAdminContext(ctx, "admin-1")),
              });
              assert(!listed.error, listed.error ?? "OAuth listing failed");
              const page = backofficeOAuthClientPageSchema.parse(listed.result);
              expect(page.clients.map((client) => client.clientId)).toContain(created.clientId);
              expect(listed.toolCalls).toEqual([
                expect.objectContaining({
                  providerName,
                  toolId: "admin.oauth-clients.list",
                  status: "success",
                }),
              ]);
              const summary = listed.toolCalls[0].resultSummary;
              assert(summary);
              expect(summary).toContain(created.clientId);
              expect(summary).not.toBe("[redacted]");
              expect(JSON.stringify(listed.toolCalls)).not.toContain(created.clientSecret);
            }),
          ],
        }),
      );
    },
  );

  test("mounted multi-role updates retain OAuth administration while banned multi-role users remain denied", async () => {
    await runOAuthAdminSqliteScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "OAuth administrator checks use the canonical stored role",
        vars: () => ({ setterCookie: "", cookie: "" }),
        steps: ({ when, then }) => [
          when.auth.signUp({
            email: "oauth-role-setter@example.com",
            captureSessionCookieAs: "setterCookie",
          }),
          when.auth.signUp({
            email: "oauth-multi-role@example.com",
            captureSessionCookieAs: "cookie",
          }),
          then.assert(
            "role-array administration is live and agrees across Auth, kernel and managed clients",
            async (ctx) => {
              await promoteOAuthAdministrator(ctx, "oauth-role-setter@example.com");
              const auth = ctx.runtime.objects.auth.singleton().commands;
              const session = await oauthAuthRequest(ctx, "/get-session", ctx.vars.cookie);
              assert.equal(session.status, 200);
              const { user } = z
                .object({ user: z.object({ id: z.string() }) })
                .parse(await session.json());
              const updated = await oauthAuthRequest(
                ctx,
                "/admin/set-role",
                ctx.vars.setterCookie,
                { userId: user.id, role: ["user", "admin"] },
              );
              assert.equal(updated.status, 200, await updated.clone().text());
              assert.equal(
                z.object({ user: z.object({ role: z.string() }) }).parse(await updated.json()).user
                  .role,
                "user,admin",
              );
              const facts = await auth.getUserAuthorityFacts({ userId: user.id });
              assert.equal(facts.role, "admin");
              assert(facts.active);
              const firstPage = await auth.listAdminOAuthClients({
                pageSize: 25,
                cursor: null,
                administratorUserId: user.id,
              });
              assert(firstPage.clients.length > 0);
              const tools = createBackofficeToolContext(oauthAdminContext(ctx, user.id));
              const created = await executeBackofficeRuntimeTool(
                adminOAuthClientsRuntimeTools[0],
                clientInput,
                tools,
              );
              assert(created.clientType === "confidential");
              const raw = await oauthAuthRequest(ctx, "/oauth2/create-client", ctx.vars.cookie, {
                client_name: "Multi-role public client",
                redirect_uris: clientInput.redirectUris,
                scope: "openid",
                token_endpoint_auth_method: "none",
              });
              assert.equal(raw.status, 201, await raw.clone().text());
              const rawClient = z.object({ client_id: z.string() }).parse(await raw.json());
              const catalog = await executeBackofficeRuntimeTool(
                adminOAuthClientsRuntimeTools[1],
                {},
                tools,
              );
              expect(catalog.clients.map((client) => client.clientId)).toEqual(
                expect.arrayContaining([created.clientId, rawClient.client_id]),
              );
              const metadata = await oauthAuthRequest(
                ctx,
                `/oauth2/get-client?client_id=${created.clientId}`,
                ctx.vars.cookie,
              );
              assert.equal(metadata.status, 200, await metadata.clone().text());
              assert.equal(clientMetadataSchema.parse(await metadata.json()).user_id, user.id);
              const banned = await oauthAuthRequest(ctx, "/admin/ban-user", ctx.vars.setterCookie, {
                userId: user.id,
              });
              assert.equal(banned.status, 200, await banned.clone().text());
              const bannedUser = z
                .object({ user: z.object({ role: z.string(), banned: z.boolean() }) })
                .parse(await banned.json()).user;
              assert.equal(bannedUser.role, "user,admin");
              assert(bannedUser.banned);
              const bannedFacts = await auth.getUserAuthorityFacts({ userId: user.id });
              assert.equal(bannedFacts.role, "admin");
              assert.equal(bannedFacts.active, false);
              await expect(
                auth.listAdminOAuthClients({
                  pageSize: 25,
                  cursor: null,
                  administratorUserId: user.id,
                }),
              ).rejects.toThrow("requires an active administrator user");
              await expect(
                auth.createAdminOAuthClient({
                  ...clientInput,
                  clientType: "confidential",
                  applicationType: "web",
                  administratorUserId: user.id,
                }),
              ).rejects.toThrow();
              await expect(
                executeBackofficeRuntimeTool(adminOAuthClientsRuntimeTools[1], {}, tools),
              ).rejects.toThrow();
              const denied = await oauthAuthRequest(ctx, "/oauth2/create-client", ctx.vars.cookie, {
                client_name: "Banned client",
                redirect_uris: clientInput.redirectUris,
                scope: "openid",
              });
              assert.equal(denied.ok, false);
            },
          ),
        ],
      }),
    );
  });
  test("Bash renders confidential credentials, secretless public clients, and metadata catalogs as text with redacted creation logs", async () => {
    await runOAuthAdminSqliteScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "readable Bash OAuth client management output",
        setup: ({ given }) => [given.auth.user({ id: "admin-1", role: "admin" })],
        steps: ({ then }) => [
          then.assert(
            "text output returns creation credentials only to the caller",
            async (ctx) => {
              const context = oauthAdminContext(ctx, "admin-1");
              assert(context.stateBackend);
              const { bash, commandCallsResult } = createInteractiveBashHost({
                context: { ...context, stateBackend: context.stateBackend },
              });
              const confidential = await bash.exec(
                "admin.oauth-clients.create --name Accounting --redirect-uri https://accounting.example/callback --scope openid --scope profile",
              );
              assert.equal(confidential.exitCode, 0, confidential.stderr);
              const credentials = /^Client ID: (.+)\nClient secret: (.+)$/m.exec(
                confidential.stdout,
              );
              assert(credentials);
              const [, clientId, clientSecret] = credentials;
              assert.equal(
                confidential.stdout,
                `Created confidential OAuth client.\nClient ID: ${clientId}\nClient secret: ${clientSecret}\nStore this secret securely; it is only returned at creation.\n`,
              );
              assert(
                await ctx.runtime.objects.auth.singleton().commands.hasOAuthClient({ clientId }),
              );
              const publicResult = await bash.exec(
                'admin.oauth-clients.create --name "Accounting SPA" --redirect-uri https://accounting.example/callback --scope openid --client-type public --format text',
              );
              assert.equal(publicResult.exitCode, 0, publicResult.stderr);
              const tools = createBackofficeToolContext(context);
              const page = await executeBackofficeRuntimeTool(
                adminOAuthClientsRuntimeTools[1],
                {},
                tools,
              );
              const publicClient = page.clients.find((client) => client.name === "Accounting SPA");
              assert(publicClient);
              assert.equal(
                publicResult.stdout,
                `Created public OAuth client.\nClient ID: ${publicClient.clientId}\nClient secret: none (public client)\n`,
              );
              for (const command of [
                "admin.oauth-clients.list",
                "admin.oauth-clients.list --format text",
              ]) {
                const listed = await bash.exec(command);
                assert.equal(listed.exitCode, 0, listed.stderr);
                expect(listed.stdout).toContain(`Client ID: ${clientId}\n  Name: Accounting\n`);
                expect(listed.stdout).toContain(
                  "Redirect URIs: https://accounting.example/callback\n",
                );
                expect(listed.stdout).toContain("OAuth scopes: openid profile\n");
                expect(listed.stdout).toContain(
                  "Token endpoint auth method: client_secret_basic\n",
                );
                expect(listed.stdout).toContain("Owner user ID: admin-1\n");
                expect(listed.stdout).toContain("Reference ID: none\n");
                expect(listed.stdout).toContain("Disabled: no\n");
                expect(listed.stdout).toContain("More results: no\nNext cursor: none\n");
                expect(listed.stdout).not.toContain(clientSecret);
                expect(listed.stdout).not.toContain("Client secret:");
              }
              const printed = await bash.exec(
                "admin.oauth-clients.list --print clients.0.clientId",
              );
              assert.equal(printed.exitCode, 0, printed.stderr);
              assert.equal(printed.stdout, `${page.clients[0].clientId}\n`);
              const printedCreate = await bash.exec(
                'admin.oauth-clients.create --name "Printed SPA" --redirect-uri https://accounting.example/callback --scope openid --client-type public --print clientId',
              );
              assert.equal(printedCreate.exitCode, 0, printedCreate.stderr);
              assert(
                await ctx.runtime.objects.auth
                  .singleton()
                  .commands.hasOAuthClient({ clientId: printedCreate.stdout.trim() }),
              );
              for (const call of commandCallsResult.filter(
                (call) => call.command === "admin.oauth-clients.create",
              )) {
                assert.equal(call.output, "[redacted]");
              }
              expect(JSON.stringify(commandCallsResult)).not.toContain(clientSecret);
            },
          ),
        ],
      }),
    );
  });
  test("the global client catalog spans owners and paginates across Auth restart", async () => {
    let cursor: string | null = null;
    const seen: string[] = [];
    const expected: string[] = [];
    await runOAuthAdminSqliteScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "paginate the global OAuth client catalog",
        setup: ({ given }) => [
          given.auth.user({ id: "admin-1", role: "admin" }),
          given.auth.user({ id: "admin-2", role: "admin" }),
        ],
        steps: ({ then, runner }) => [
          then.assert(
            "a global administrator sees every publisher and the deployment client",
            async (ctx) => {
              for (const userId of ["admin-1", "admin-2"]) {
                const tools = createBackofficeToolContext(oauthAdminContext(ctx, userId));
                const created = await executeBackofficeRuntimeTool(
                  adminOAuthClientsRuntimeTools[0],
                  { ...clientInput, name: userId },
                  tools,
                );
                expected.push(created.clientId);
              }
              const cli = await ctx.runtime.objects.auth
                .singleton()
                .commands.getBackofficeCliOAuthConfig({ requestUrl: "https://backoffice.example" });
              expected.push(cli.clientId);
              const tools = createBackofficeToolContext(oauthAdminContext(ctx, "admin-1"));
              const catalog = await executeBackofficeRuntimeTool(
                adminOAuthClientsRuntimeTools[1],
                {},
                tools,
              );
              expect(catalog.clients.map(({ userId }) => userId)).toEqual(
                expect.arrayContaining(["admin-1", "admin-2", null]),
              );
              const page = await executeBackofficeRuntimeTool(
                adminOAuthClientsRuntimeTools[1],
                { pageSize: 1 },
                tools,
              );
              assert.equal(page.clients.length, 1);
              assert(page.hasNextPage);
              assert(page.nextCursor);
              cursor = page.nextCursor;
              seen.push(page.clients[0].clientId);
              const context = oauthAdminContext(ctx, "admin-1");
              assert(context.stateBackend);
              const { bash } = createInteractiveBashHost({
                context: { ...context, stateBackend: context.stateBackend },
              });
              const text = await bash.exec("admin.oauth-clients.list --page-size 1");
              assert.equal(text.exitCode, 0, text.stderr);
              expect(text.stdout).toContain(
                `OAuth clients (1):\nClient ID: ${page.clients[0].clientId}\n`,
              );
              expect(text.stdout).toContain(`More results: yes\nNext cursor: ${cursor}\n`);
              for (const otherId of expected.filter((id) => id !== page.clients[0].clientId)) {
                expect(text.stdout).not.toContain(otherId);
              }
              for (const invalid of [
                { pageSize: 2, cursor },
                { pageSize: 1, cursor: "invalid-cursor" },
              ]) {
                await expect(
                  executeBackofficeRuntimeTool(adminOAuthClientsRuntimeTools[1], invalid, tools),
                ).rejects.toThrow("listing cursor is invalid");
              }
              for (const invalid of [
                { pageSize: 0 },
                { pageSize: 101 },
                { administratorUserId: "admin-2" },
              ]) {
                await expect(
                  executeBackofficeRuntimeTool(adminOAuthClientsRuntimeTools[1], invalid, tools),
                ).rejects.toThrow();
              }
            },
          ),
          runner.restartObject({ binding: "AUTH", scope: { kind: "singleton" } }),
          then.assert(
            "resume with an opaque cursor without missing or repeating clients",
            async (ctx) => {
              const tools = createBackofficeToolContext(oauthAdminContext(ctx, "admin-2"));
              while (cursor !== null) {
                const page = await executeBackofficeRuntimeTool(
                  adminOAuthClientsRuntimeTools[1],
                  { pageSize: 1, cursor },
                  tools,
                );
                assert.equal(page.clients.length, 1);
                seen.push(page.clients[0].clientId);
                cursor = page.nextCursor;
                assert.equal(page.hasNextPage, cursor !== null);
              }
              expect(seen).toEqual(
                expected.sort((left, right) => (left === right ? 0 : left < right ? -1 : 1)),
              );
              assert.equal(new Set(seen).size, expected.length);
            },
          ),
        ],
      }),
    );
  });

  test("ordinary users and banned administrators cannot enumerate the global catalog", async () => {
    await runOAuthAdminSqliteScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "OAuth client catalog reads fail closed on current authority",
        setup: ({ given }) => [
          given.auth.user({ id: "admin-1", role: "admin" }),
          given.auth.user({ id: "user-1" }),
        ],
        steps: ({ then, when }) => [
          then.assert(
            "ordinary users cannot read through either tool or Auth command",
            async (ctx) => {
              const tools = createBackofficeToolContext(oauthAdminContext(ctx, "user-1"));
              await expect(
                executeBackofficeRuntimeTool(adminOAuthClientsRuntimeTools[1], {}, tools),
              ).rejects.toThrow("Required permission: admin.oauth-clients.read.");
              await expect(
                ctx.runtime.objects.auth.singleton().commands.listAdminOAuthClients({
                  pageSize: 25,
                  cursor: null,
                  administratorUserId: "user-1",
                }),
              ).rejects.toThrow("requires an active administrator user");
            },
          ),
          when.auth.setUserStatus({ userId: "admin-1", status: "banned" }),
          then.assert(
            "a banned administrator cannot bypass the kernel through the RPC",
            async (ctx) => {
              const tools = createBackofficeToolContext(oauthAdminContext(ctx, "admin-1"));
              await expect(
                executeBackofficeRuntimeTool(adminOAuthClientsRuntimeTools[1], {}, tools),
              ).rejects.toThrow();
              await expect(
                ctx.runtime.objects.auth.singleton().commands.listAdminOAuthClients({
                  pageSize: 25,
                  cursor: null,
                  administratorUserId: "admin-1",
                }),
              ).rejects.toThrow("requires an active administrator user");
            },
          ),
        ],
      }),
    );
  });
  test("Codemode and Bash provision real Auth credentials independently of app registration and survive restart", async () => {
    await runOAuthAdminSqliteScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "create OAuth credentials then register a Backoffice app",
        vars: () => ({ cookie: "", userId: "", clientId: "", clientSecret: "" }),
        steps: ({ when, then, runner }) => [
          when.auth.signUp({ email: "oauth-admin@example.com", captureSessionCookieAs: "cookie" }),
          then.assert(
            "both adapters create Auth-owned clients with protected tool records",
            async (ctx) => {
              ctx.vars.userId = await promoteOAuthAdministrator(ctx, "oauth-admin@example.com");
              const context = oauthAdminContext(ctx, ctx.vars.userId);
              assert(ctx.runtime.env.codemode);
              assert(context.stateBackend);
              const result = await runBackofficeCodemode({
                code: `async () => await admin.oauthClientsCreate(${JSON.stringify(clientInput)})`,
                env: ctx.runtime.env.codemode,
                families: runtimeToolFamilies,
                toolContext: createBackofficeToolContext(context),
              });
              assert(!result.error, result.error ?? "Codemode failed");
              const created = backofficeOAuthClientCreateResultSchema.parse(result.result);
              assert(created.clientType === "confidential");
              ctx.vars.clientId = created.clientId;
              ctx.vars.clientSecret = created.clientSecret;
              expect(result.toolCalls).toEqual([
                expect.objectContaining({
                  toolId: "admin.oauth-clients.create",
                  status: "success",
                  resultSummary: "[redacted]",
                }),
              ]);
              expect(JSON.stringify(result.toolCalls)).not.toContain(created.clientSecret);

              const response = await oauthAuthRequest(
                ctx,
                `/oauth2/get-client?client_id=${created.clientId}`,
                ctx.vars.cookie,
              );
              assert.equal(response.status, 200, await response.clone().text());
              const raw: unknown = await response.json();
              expect(raw).not.toHaveProperty("client_secret");
              expect(clientMetadataSchema.parse(raw)).toEqual({
                client_id: created.clientId,
                client_name: clientInput.name,
                user_id: ctx.vars.userId,
                redirect_uris: clientInput.redirectUris,
                scope: clientInput.scopes.join(" "),
                token_endpoint_auth_method: "client_secret_basic",
                application_type: "web",
                require_pkce: true,
                grant_types: ["authorization_code", "refresh_token"],
              });
              const beforeRegistration = await ctx.runtime.objects.apps
                .singleton()
                .commands.listApps({ pageSize: 25, cursor: null });
              assert(beforeRegistration.ok);
              expect(beforeRegistration.value.apps).toEqual([]);
              const registered = await executeBackofficeRuntimeTool(
                adminAppsRuntimeTools[0],
                {
                  oauthClientId: created.clientId,
                  requestedPermissions: [BACKOFFICE_PERMISSION.events.emit],
                },
                createBackofficeToolContext(context),
              );
              assert(registered.created);

              const { bash, commandCallsResult } = createInteractiveBashHost({
                context: { ...context, stateBackend: context.stateBackend },
              });
              const publicResult = await bash.exec(
                'admin.oauth-clients.create --name "Accounting SPA" --redirect-uri https://accounting.example/callback --scope openid --client-type public --format json',
              );
              assert.equal(publicResult.exitCode, 0, publicResult.stderr);
              const publicClient = backofficeOAuthClientCreateResultSchema.parse(
                JSON.parse(publicResult.stdout),
              );
              assert(publicClient.clientType === "public");
              assert.notEqual(publicClient.clientId, created.clientId);
              expect(publicClient.clientSecret).toBeNull();
              const listed = await runBackofficeCodemode({
                code: "async () => await admin.oauthClientsList({})",
                env: ctx.runtime.env.codemode,
                families: runtimeToolFamilies,
                toolContext: createBackofficeToolContext(context),
              });
              assert(!listed.error, listed.error ?? "OAuth client listing failed");
              const page = backofficeOAuthClientPageSchema.parse(listed.result);
              expect(page.clients.map((client) => client.clientId)).toEqual(
                expect.arrayContaining([created.clientId, publicClient.clientId]),
              );
              assert.equal(page.clients.length, 3);
              expect(JSON.stringify(page)).not.toContain(created.clientSecret);
              for (const client of page.clients) {
                expect(client).not.toHaveProperty("clientSecret");
                expect(client).not.toHaveProperty("client_secret");
              }
              const bashPage = await bash.exec("admin.oauth-clients.list --format json");
              assert.equal(bashPage.exitCode, 0, bashPage.stderr);
              expect(backofficeOAuthClientPageSchema.parse(JSON.parse(bashPage.stdout))).toEqual(
                page,
              );
              expect(commandCallsResult).toContainEqual(
                expect.objectContaining({
                  command: "admin.oauth-clients.create",
                  output: "[redacted]",
                }),
              );
              const publicMetadataResponse = await oauthAuthRequest(
                ctx,
                `/oauth2/get-client?client_id=${publicClient.clientId}`,
                ctx.vars.cookie,
              );
              expect(clientMetadataSchema.parse(await publicMetadataResponse.json())).toMatchObject(
                {
                  token_endpoint_auth_method: "none",
                  application_type: "web",
                  require_pkce: true,
                  grant_types: ["authorization_code"],
                },
              );
            },
          ),
          runner.restartObject({ binding: "AUTH", scope: { kind: "singleton" } }),
          then.assert(
            "the returned confidential secret authenticates after an Auth restart",
            async (ctx) => {
              const auth = ctx.runtime.objects.auth.singleton();
              assert(await auth.commands.hasOAuthClient({ clientId: ctx.vars.clientId }));
              for (const secret of ["wrong-secret", ctx.vars.clientSecret]) {
                const grant = await authorizeOAuthClient(ctx, ctx.vars.cookie, ctx.vars.clientId);
                const response = await auth.http.fetch(
                  new Request("https://backoffice.example/api/auth/oauth2/token", {
                    method: "POST",
                    headers: {
                      "content-type": "application/x-www-form-urlencoded",
                      authorization: `Basic ${btoa(`${ctx.vars.clientId}:${secret}`)}`,
                    },
                    body: new URLSearchParams({
                      grant_type: "authorization_code",
                      code: grant.code,
                      redirect_uri: clientInput.redirectUris[0],
                      code_verifier: grant.codeVerifier,
                    }),
                  }),
                );
                if (secret === "wrong-secret") {
                  assert.equal(response.status, 401, await response.clone().text());
                  assert.equal(
                    z.object({ error: z.string() }).parse(await response.json()).error,
                    "invalid_client",
                  );
                } else {
                  assert.equal(response.status, 200, await response.clone().text());
                  z.object({
                    access_token: z.string().min(1),
                    id_token: z.string().min(1),
                    refresh_token: z.string().min(1),
                  }).parse(await response.json());
                }
              }
              const anonymous = await auth.http.fetch(
                new Request("http://localhost/api/auth/get-session"),
              );
              assert.equal(await anonymous.json(), null);
              const cli = await auth.commands.getBackofficeCliOAuthConfig({
                requestUrl: "https://backoffice.example",
              });
              assert.notEqual(cli.clientId, ctx.vars.clientId);
              assert.equal(cli.scope, "openid offline_access backoffice");
            },
          ),
        ],
      }),
    );
  });

  test("raw managed endpoints and runtime tools reject non-admins, including after live role removal", async () => {
    let reusedContext: ReturnType<typeof oauthAdminContext> | null = null;
    await runOAuthAdminSqliteScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "OAuth management checks live global administrator authority",
        vars: () => ({ cookie: "", userId: "" }),
        steps: ({ when, then }) => [
          when.auth.signUp({ email: "oauth-role@example.com", captureSessionCookieAs: "cookie" }),
          then.assert("a signed-in ordinary user cannot use managed creation", async (ctx) => {
            const response = await oauthAuthRequest(ctx, "/oauth2/create-client", ctx.vars.cookie, {
              client_name: "Unauthorized",
              redirect_uris: clientInput.redirectUris,
              scope: "openid",
            });
            assert.equal(response.status, 401);
            ctx.vars.userId = await promoteOAuthAdministrator(ctx, "oauth-role@example.com");
            reusedContext = oauthAdminContext(ctx, ctx.vars.userId);
            const created = await executeBackofficeRuntimeTool(
              adminOAuthClientsRuntimeTools[0],
              clientInput,
              createBackofficeToolContext(reusedContext),
            );
            assert(created.clientId);
          }),
          then.assert(
            "old cookies and tool contexts cannot retain administrator access",
            async (ctx) => {
              await setScenarioAuthUserRole(ctx.runtime, { userId: ctx.vars.userId, role: "user" });
              assert(reusedContext);
              const tools = createBackofficeToolContext(reusedContext);
              await expect(
                executeBackofficeRuntimeTool(adminOAuthClientsRuntimeTools[0], clientInput, tools),
              ).rejects.toThrow("Required permission: admin.oauth-clients.manage.");
              await expect(
                executeBackofficeRuntimeTool(adminOAuthClientsRuntimeTools[1], {}, tools),
              ).rejects.toThrow("Required permission: admin.oauth-clients.read.");
              assert(reusedContext.stateBackend);
              const { bash } = createInteractiveBashHost({
                context: { ...reusedContext, stateBackend: reusedContext.stateBackend },
              });
              const denied = await bash.exec(
                "admin.oauth-clients.create --name Denied --redirect-uri https://accounting.example/callback --scope openid",
              );
              assert.notEqual(denied.exitCode, 0);
              expect(denied.stderr).toContain("Required permission: admin.oauth-clients.manage.");
              const deniedList = await bash.exec("admin.oauth-clients.list --format json");
              assert.notEqual(deniedList.exitCode, 0);
              expect(deniedList.stderr).toContain("Required permission: admin.oauth-clients.read.");
              assert(ctx.runtime.env.codemode);
              const codemode = await runBackofficeCodemode({
                code: `async () => await admin.oauthClientsCreate(${JSON.stringify(clientInput)})`,
                env: ctx.runtime.env.codemode,
                families: runtimeToolFamilies,
                toolContext: tools,
              });
              expect(codemode.error).toContain("Required permission: admin.oauth-clients.manage.");
              const deniedCatalog = await runBackofficeCodemode({
                code: "async () => await admin.oauthClientsList({})",
                env: ctx.runtime.env.codemode,
                families: runtimeToolFamilies,
                toolContext: tools,
              });
              expect(deniedCatalog.error).toContain(
                "Required permission: admin.oauth-clients.read.",
              );
              await expect(
                ctx.runtime.objects.auth.singleton().commands.listAdminOAuthClients({
                  pageSize: 25,
                  cursor: null,
                  administratorUserId: ctx.vars.userId,
                }),
              ).rejects.toThrow("requires an active administrator user");
              const raw = await oauthAuthRequest(ctx, "/oauth2/create-client", ctx.vars.cookie, {
                client_name: "Denied",
                redirect_uris: clientInput.redirectUris,
                scope: "openid",
              });
              assert.equal(raw.status, 401);
              await expect(
                ctx.runtime.objects.auth.singleton().commands.createAdminOAuthClient({
                  ...clientInput,
                  clientType: "confidential",
                  applicationType: "web",
                  administratorUserId: ctx.vars.userId,
                }),
              ).rejects.toThrow();
            },
          ),
          then.assert("denied operations created no clients", async (ctx) => {
            await setScenarioAuthUserRole(ctx.runtime, { userId: ctx.vars.userId, role: "admin" });
            const response = await oauthAuthRequest(ctx, "/oauth2/get-clients", ctx.vars.cookie);
            assert.equal(response.status, 200, await response.clone().text());
            expect(
              z.array(z.object({ client_id: z.string() })).parse(await response.json()),
            ).toHaveLength(1);
          }),
        ],
      }),
    );
  });

  test("OAuth provisioning is unavailable outside System and cannot forge a credential owner", async () => {
    await runOAuthAdminSqliteScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "restrict OAuth provisioning to the administrator principal",
        setup: ({ given }) => [given.auth.user({ id: "admin-1", role: "admin" })],
        steps: ({ then }) => [
          then.assert("scope and strict inputs prevent authority substitution", async (ctx) => {
            for (const scope of [
              { kind: "user", userId: "admin-1" },
              { kind: "org", orgId: "org-1" },
              { kind: "project", orgId: "org-1", projectId: "project-1" },
            ] satisfies BackofficeContextScope[]) {
              const context = oauthAdminContext(ctx, "admin-1", scope);
              expect(context.admin).toBeNull();
              await expect(
                executeBackofficeRuntimeTool(
                  adminOAuthClientsRuntimeTools[0],
                  clientInput,
                  createBackofficeToolContext(context),
                ),
              ).rejects.toThrow();
              await expect(
                executeBackofficeRuntimeTool(
                  adminOAuthClientsRuntimeTools[1],
                  {},
                  createBackofficeToolContext(context),
                ),
              ).rejects.toThrow();
            }
            const tools = createBackofficeToolContext(oauthAdminContext(ctx, "admin-1"));
            for (const input of [
              { ...clientInput, administratorUserId: "other-user" },
              { ...clientInput, skipConsent: true },
              { ...clientInput, clientType: "invalid" },
              { ...clientInput, applicationType: "invalid" },
              { ...clientInput, applicationType: null },
              { ...clientInput, scopes: ["events.emit"] },
              { ...clientInput, redirectUris: [] },
            ]) {
              await expect(
                executeBackofficeRuntimeTool(adminOAuthClientsRuntimeTools[0], input, tools),
              ).rejects.toThrow();
            }
            const registry = await ctx.runtime.objects.apps
              .singleton()
              .commands.listApps({ pageSize: 25, cursor: null });
            assert(registry.ok);
            expect(registry.value.apps).toEqual([]);
          }),
        ],
      }),
    );
  });

  test("concurrent provisioning does not seed HTTP sessions or mix client ownership", async () => {
    await runOAuthAdminSqliteScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "keep OAuth endpoint session context isolated",
        vars: () => ({ cookie: "", userId: "" }),
        steps: ({ when, then }) => [
          when.auth.signUp({
            email: "oauth-concurrent@example.com",
            captureSessionCookieAs: "cookie",
          }),
          then.assert(
            "parallel control-plane commands cannot authenticate anonymous requests",
            async (ctx) => {
              ctx.vars.userId = await promoteOAuthAdministrator(
                ctx,
                "oauth-concurrent@example.com",
              );
              const auth = ctx.runtime.objects.auth.singleton();
              const tools = createBackofficeToolContext(oauthAdminContext(ctx, ctx.vars.userId));
              const results = await Promise.all(
                Array.from({ length: 3 }, async (_, index) => {
                  const [created, anonymous] = await Promise.all([
                    executeBackofficeRuntimeTool(
                      adminOAuthClientsRuntimeTools[0],
                      { ...clientInput, name: `Concurrent ${index}` },
                      tools,
                    ),
                    auth.http.fetch(new Request("http://localhost/api/auth/get-session")),
                  ]);
                  assert.equal(await anonymous.json(), null);
                  const metadata = await oauthAuthRequest(
                    ctx,
                    `/oauth2/get-client?client_id=${created.clientId}`,
                    ctx.vars.cookie,
                  );
                  assert.equal(
                    clientMetadataSchema.parse(await metadata.json()).user_id,
                    ctx.vars.userId,
                  );
                  return created.clientId;
                }),
              );
              assert.equal(new Set(results).size, 3);
              const cli = await auth.commands.getBackofficeCliOAuthConfig({
                requestUrl: "http://localhost",
              });
              expect(results).not.toContain(cli.clientId);
            },
          ),
        ],
      }),
    );
  });
});
