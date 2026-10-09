import { assert, expect, test, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { withBackofficeActorCapabilityGrants } from "@/backoffice-runtime/authority-resolver";
import {
  createBackofficeSystemExecution,
  type BackofficeContextScope,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "@/backoffice-runtime/permissions";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
  type BackofficeScenarioDefinitionInput,
} from "@/fragno/automation/scenario";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { InMemoryApiObject } from "../../../../../workers/api.do";
import { createApiIntegration } from "./api-integration";
import { integrationSetupProgressSchema } from "./integration-contracts";

const orgScope = { kind: "org", orgId: "api-org" } as const;
const providerOrigin = "https://billing.provider.test";
const oauthAuth = {
  type: "oauth",
  authorizationEndpoint: "https://auth.provider.test/authorize",
  tokenEndpoint: "https://auth.provider.test/token",
  clientId: "backoffice-client",
  clientSecret: "oauth-client-secret",
  scopes: ["invoices.read"],
};

const delegatedActor = {
  scope: "internal",
  type: "agent",
  id: "api-integration-agent",
  role: "assistant",
} as const;

type ApiProvider = {
  requests: { method: string; path: string; authorization: string | null }[];
  codeExchanges: string[];
  control: { expiresIn: number; refreshToken: boolean };
  /** Grants the delegated actor holds at both the caller and the receiving API object. */
  delegatedGrants: BackofficePermissionRequirement[];
};

async function runApiIntegrationScenario<TVars extends Record<string, unknown>>(
  defineScenario: (provider: ApiProvider) => BackofficeScenarioDefinitionInput<TVars>,
) {
  const provider: ApiProvider = {
    requests: [],
    codeExchanges: [],
    control: { expiresIn: 3600, refreshToken: true },
    delegatedGrants: [],
  };
  const providerFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.href === oauthAuth.tokenEndpoint) {
      const body = new URLSearchParams(await request.text());
      assert(body.get("grant_type") === "authorization_code", "Unexpected OAuth grant");
      const code = body.get("code");
      assert(code, "OAuth exchange requires a code");
      provider.codeExchanges.push(code);
      return Response.json({
        access_token: `access-${code}`,
        token_type: "Bearer",
        expires_in: provider.control.expiresIn,
        ...(provider.control.refreshToken ? { refresh_token: `refresh-${code}` } : {}),
      });
    }
    assert(url.origin === providerOrigin, `Unexpected provider request to ${url.origin}`);
    provider.requests.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.get("authorization"),
    });
    return url.pathname === "/missing"
      ? Response.json({ message: "No such invoice" }, { status: 404 })
      : Response.json({ invoices: [{ id: "inv_1" }] });
  };
  const directory = await mkdtemp(path.join(tmpdir(), "backoffice-api-integration-"));
  try {
    const scenario = defineScenario(provider);
    await runBackofficeScenario(
      defineBackofficeScenario({
        ...scenario,
        options: { ...scenario.options, sqliteDataDirectory: directory },
        objectOverrides: {
          ...scenario.objectOverrides,
          API: (options) =>
            new InMemoryApiObject({
              ...options,
              runtime: {
                ...options.runtime,
                authorityResolver: withBackofficeActorCapabilityGrants({
                  resolver: options.runtime.authorityResolver,
                  actor: delegatedActor,
                  grants: provider.delegatedGrants,
                }),
              },
              fetch: providerFetch,
            }),
        },
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function createIntegrationScenarioTerminal(
  runtime: BackofficeRuntimeServices,
  execution: BackofficeExecutionContext,
  kernel: BackofficeKernel,
) {
  const context = createRouteBackedRuntimeContext({
    runtime,
    execution,
    kernel,
    billingOrganizationId: null,
  });
  assert(context.stateBackend);
  return createInteractiveBashHost({ context: { ...context, stateBackend: context.stateBackend } })
    .bash;
}

function createDelegatedExecution(
  ctx: BackofficeScenarioContext,
  scope: BackofficeContextScope,
  provider: ApiProvider,
  grants: readonly BackofficePermissionRequirement[],
) {
  provider.delegatedGrants.splice(0, provider.delegatedGrants.length, ...grants);
  const system = createBackofficeSystemExecution(scope);
  return {
    execution: { ...system, actors: { ...system.actors, delegation: [delegatedActor] } },
    kernel: new BackofficeKernel({
      ...ctx.runtime.services,
      authorityResolver: withBackofficeActorCapabilityGrants({
        resolver: ctx.runtime.services.authorityResolver,
        actor: delegatedActor,
        grants: provider.delegatedGrants,
      }),
    }),
  };
}

/** Consent happens in the provider's browser flow; the callback is the only signal setup sees. */
async function completeConsent(
  ctx: BackofficeScenarioContext,
  scope: BackofficeContextScope & { kind: "user" | "org" | "project" },
  authorizationUrl: string,
  code: string,
) {
  const state = new URL(authorizationUrl).searchParams.get("state");
  assert(state, "Authorization link must carry OAuth state");
  const callback = await ctx.runtime.objects.api
    .for(scope)
    .http.fetch(
      new Request(
        `https://api.do/api/api/oauth/callback?code=${code}&state=${encodeURIComponent(state)}`,
      ),
    );
  assert(callback.ok, await callback.clone().text());
}

test("Codemode creates a custom API through setup and keeps one address across restart, credential reset, and deletion", async () => {
  await runApiIntegrationScenario((provider) => ({
    name: "API bearer setup and execution through the registered facade",
    setup: ({ given }) => [
      given.organization.exists({ id: orgScope.orgId, slug: "api-org", name: "API Org" }),
    ],
    steps: ({ then, runner }) => [
      then.assert(
        "an empty scope still advertises the service and setup checks create nothing",
        async (ctx) => {
          const run = await ctx.runCodemode({
            scope: orgScope,
            code: `async () => {
              const services = await integrations.discover();
              const check = await integrations.setup({ kind: "check", connectionId: "api#billing" });
              const invalid = await integrations.setup({ kind: "check", connectionId: "api#has space" });
              let nullInput = "accepted";
              try { await integrations.setup({ kind: "input", connectionId: "api#billing", input: null }); }
              catch { nullInput = "rejected"; }
              return { services, check, invalid, nullInput, page: await integrations.list({ cursor: null }) };
            }`,
            assertToolCalls: ["integrations.discover", "integrations.setup", "integrations.list"],
          });
          expect(run.result).toMatchObject({
            services: expect.arrayContaining([
              {
                id: "api",
                label: "Custom HTTP API",
                description: expect.stringContaining("api#<slug>"),
                connectionCardinality: "multiple",
                availability: { status: "available" },
                setupTargets: [],
                automationEvents: expect.arrayContaining([
                  { source: "api", eventType: "webhook.received" },
                ]),
              },
            ]),
            check: {
              status: "needs-input",
              connectionId: "api#billing",
              // The callback is known before any OAuth app or credentials exist.
              instructions: expect.stringContaining(
                "https://example.com/api/http/org%3Aapi-org/oauth/callback",
              ),
              secretFields: ["token", "password", "clientSecret"],
            },
            invalid: { status: "blocked", connectionId: "api#has space" },
            nullInput: "rejected",
            page: { connections: [], cursor: null },
          });
          const requirements = integrationSetupProgressSchema.parse(
            (run.result as { check: unknown }).check,
          );
          assert(requirements.status === "needs-input");
          // Input chooses neither the slug, the owner scope, nor the OAuth callback.
          expect(JSON.stringify(requirements.inputSchema)).not.toMatch(
            /"(slug|scope|redirectUri)"/,
          );
          expect(provider.requests).toEqual([]);
        },
      ),
      then.assert(
        "setup saves credentials once in the source store and execution uses them",
        async (ctx) => {
          const run = await ctx.runCodemode({
            scope: orgScope,
            code: `async () => {
              const target = { connectionId: "api#billing" };
              const ready = await integrations.setup({ ...target, kind: "input", input: {
                type: "bearer", name: "Billing", baseUrl: ${JSON.stringify(providerOrigin)}, token: "first-token",
              } });
              const repeated = await integrations.setup({ ...target, kind: "input", input: {
                type: "bearer", baseUrl: ${JSON.stringify(providerOrigin)}, token: "must-not-replace",
              } });
              const actions = await integrations.actions(target);
              const invoices = await integrations.execute({ ...target, actionId: "request", input: {
                method: "GET", path: "/invoices", body: { type: "empty" },
              } });
              const missing = await integrations.execute({ ...target, actionId: "request", input: {
                method: "GET", path: "/missing", body: { type: "empty" },
              } });
              let slugInput = "accepted";
              try {
                await integrations.execute({ ...target, actionId: "request", input: {
                  slug: "other", method: "GET", path: "/invoices", body: { type: "empty" },
                } });
              } catch { slugInput = "rejected"; }
              return {
                ready, repeated, actions, invoices, missing, slugInput,
                page: await integrations.list({ cursor: null }),
                inspected: await integrations.get(target),
              };
            }`,
          });
          expect(run.result).toMatchObject({
            ready: { status: "ready", connectionId: "api#billing" },
            repeated: { status: "ready", connectionId: "api#billing" },
            actions: [
              {
                id: "request",
                inputSchema: { type: "object", additionalProperties: false },
                outputSchema: { oneOf: expect.any(Array) },
              },
              {
                id: "connection.describe",
                inputSchema: { type: "object", additionalProperties: false },
                outputSchema: { type: "object" },
              },
            ],
            invoices: {
              ok: true,
              response: {
                status: 200,
                body: { type: "json", value: { invoices: [{ id: "inv_1" }] } },
              },
              error: null,
            },
            // Upstream failures are results of an executed request, never thrown or retried.
            missing: {
              ok: false,
              response: { status: 404 },
              error: { code: "HTTP_ERROR", message: "No such invoice" },
            },
            slugInput: "rejected",
            page: {
              connections: [
                {
                  connectionId: "api#billing",
                  integrationId: "api",
                  name: "Billing",
                  configuration: { status: "configured" },
                  authorization: { status: "not-checked" },
                  checks: [],
                },
              ],
            },
            inspected: {
              connectionId: "api#billing",
              integrationId: "api",
              name: "Billing",
              authorization: { status: "available" },
              checks: [],
            },
          });
          expect(JSON.stringify(run.result)).not.toContain("first-token");
          expect(provider.requests).toEqual([
            { method: "GET", path: "/invoices", authorization: "Bearer first-token" },
            { method: "GET", path: "/missing", authorization: "Bearer first-token" },
          ]);
        },
      ),
      runner.drain(),
      then.automation.event({
        scope: orgScope,
        where: { source: "integrations", eventType: "connection.ready" },
        expected: { subject: { service: "api", connectionId: "api#billing" } },
      }),
      runner.restartObject({ binding: "API", scope: orgScope }),
      then.assert(
        "verification after restart reports stored state without contacting the provider",
        async (ctx) => {
          const run = await ctx.runCodemode({
            scope: orgScope,
            code: `async () => await integrations.verify({ connectionId: "api#billing" })`,
          });
          expect(run.result).toMatchObject({
            connectionId: "api#billing",
            authorization: { status: "available" },
            checks: [],
          });
          expect(provider.requests).toHaveLength(2);
        },
      ),
      then.assert(
        "a native credential reset asks for a new token instead of becoming unauthenticated",
        async (ctx) => {
          const run = await ctx.runCodemode({
            scope: orgScope,
            code: `async () => {
              const target = { connectionId: "api#billing" };
              await api.deleteAuth({ slug: "billing" });
              const inspected = await integrations.get(target);
              const check = await integrations.setup({ ...target, kind: "check" });
              const ready = await integrations.setup({ ...target, kind: "input", input: { token: "second-token" } });
              await integrations.execute({ ...target, actionId: "request", input: {
                method: "GET", path: "/invoices", body: { type: "empty" },
              } });
              return { inspected, check, ready };
            }`,
          });
          expect(run.result).toMatchObject({
            inspected: {
              authorization: { status: "missing" },
              nextSteps: ["Run setup to provide a bearer token."],
            },
            check: { status: "needs-input", secretFields: ["token"] },
            ready: { status: "ready" },
          });
          expect(provider.requests.at(-1)).toEqual({
            method: "GET",
            path: "/invoices",
            authorization: "Bearer second-token",
          });
        },
      ),
      runner.drain(),
      then.automation.event({
        scope: orgScope,
        where: { source: "integrations", eventType: "connection.unavailable" },
        expected: { subject: { service: "api", connectionId: "api#billing" } },
      }),
      then.assert(
        "reconfiguration replaces the base URL and credentials in place and describe reports them",
        async (ctx) => {
          const run = await ctx.runCodemode({
            scope: orgScope,
            code: `async () => {
              const target = { connectionId: "api#billing" };
              const before = await integrations.execute({ ...target, actionId: "connection.describe", input: {} });
              const check = await integrations.reconfigure({ ...target, kind: "check" });
              let reauthorize = "accepted";
              try { await integrations.reconfigure({ ...target, kind: "input", input: { reauthorize: true } }); }
              catch { reauthorize = "rejected"; }
              const replaced = await integrations.reconfigure({ ...target, kind: "input", input: {
                type: "basic", name: "Billing v2", baseUrl: ${JSON.stringify(`${providerOrigin}/v2`)},
                username: "billing", password: "basic-secret",
              } });
              await integrations.execute({ ...target, actionId: "request", input: {
                method: "GET", path: "/invoices", body: { type: "empty" },
              } });
              return {
                before, check, reauthorize, replaced,
                after: await integrations.execute({ ...target, actionId: "connection.describe", input: {} }),
                setup: await integrations.setup({ ...target, kind: "check" }),
              };
            }`,
            assertToolCalls: [
              "integrations.execute",
              "integrations.reconfigure",
              "integrations.setup",
            ],
          });
          expect(run.result).toEqual({
            before: {
              slug: "billing",
              name: "Billing",
              baseUrl: providerOrigin,
              authMode: "bearer",
              status: "active",
              auth: { mode: "bearer", credentials: "present" },
            },
            check: expect.objectContaining({
              status: "needs-input",
              secretFields: ["token", "password", "clientSecret"],
              // Only OAuth connections can consent again without a full replacement.
              instructions: expect.not.stringContaining("reauthorize"),
            }),
            reauthorize: "rejected",
            replaced: { status: "ready", connectionId: "api#billing" },
            after: {
              slug: "billing",
              name: "Billing v2",
              baseUrl: `${providerOrigin}/v2`,
              authMode: "basic",
              status: "active",
              auth: { mode: "basic", credentials: "present" },
            },
            setup: { status: "ready", connectionId: "api#billing" },
          });
          expect(JSON.stringify(run.result)).not.toContain("basic-secret");
          expect(provider.requests.at(-1)).toEqual({
            method: "GET",
            path: "/v2/invoices",
            authorization: `Basic ${btoa("billing:basic-secret")}`,
          });
        },
      ),
      then.assert(
        "disconnecting requires confirmation and leaves the address resolvable but unconfigured",
        async (ctx) => {
          const run = await ctx.runCodemode({
            scope: orgScope,
            code: `async () => {
              const target = { connectionId: "api#billing" };
              let unconfirmed = "accepted";
              try { await integrations.disconnect({ ...target, confirm: "api#other" }); }
              catch { unconfirmed = "rejected"; }
              const kept = await integrations.get(target);
              const disconnected = await integrations.disconnect({ ...target, confirm: "api#billing" });
              const repeated = await integrations.disconnect({ ...target, confirm: "api#billing" });
              return {
                unconfirmed, kept, disconnected, repeated,
                reconfigure: await integrations.reconfigure({ ...target, kind: "check" }),
                inspected: await integrations.get(target),
                check: await integrations.setup({ ...target, kind: "check" }),
                result: await integrations.execute({ ...target, actionId: "request", input: {
                  method: "GET", path: "/invoices", body: { type: "empty" },
                } }),
              };
            }`,
          });
          expect(run.result).toMatchObject({
            unconfirmed: "rejected",
            kept: { configuration: { status: "configured" } },
            disconnected: { connectionId: "api#billing", status: "disconnected" },
            repeated: { connectionId: "api#billing", status: "not-configured" },
            reconfigure: { status: "blocked", reason: expect.stringContaining("Run setup") },
            inspected: {
              name: "billing",
              configuration: { status: "missing", missingFields: ["baseUrl", "type"] },
            },
            check: { status: "needs-input", secretFields: ["token", "password", "clientSecret"] },
            result: { ok: false, response: null, error: { code: "CONNECTION_NOT_FOUND" } },
          });
          expect(provider.requests).toHaveLength(4);
        },
      ),
      runner.drain(),
      then.automation.event({
        scope: orgScope,
        where: { source: "integrations", eventType: "connection.disconnected" },
        expected: { subject: { service: "api", connectionId: "api#billing" } },
      }),
    ],
  }));
});

test("OAuth setup resumes source-owned consent across restarts, native restarts, and expiry", async () => {
  const scope = { kind: "user", userId: "api-user" } as const;
  await runApiIntegrationScenario<{ authorizationUrl: string }>((provider) => ({
    name: "API OAuth setup through the registered facade",
    setup: ({ given }) => [given.auth.user({ id: scope.userId, email: "api@example.test" })],
    vars: () => ({ authorizationUrl: "" }),
    steps: ({ then, runner }) => [
      then.assert(
        "submitting an OAuth configuration creates the connection and starts consent",
        async (ctx) => {
          const run = await ctx.runCodemode({
            scope,
            code: `async () => {
              const target = { connectionId: "api#invoices" };
              const announced = await integrations.setup({ ...target, kind: "check" });
              const started = await integrations.setup({ ...target, kind: "input", input: {
                name: "Invoices", baseUrl: ${JSON.stringify(providerOrigin)}, ...${JSON.stringify(oauthAuth)},
              } });
              return { announced, started, inspected: await integrations.get(target) };
            }`,
          });
          const { announced, started, inspected } = run.result as {
            announced: { instructions: string };
            started: unknown;
            inspected: unknown;
          };
          const progress = integrationSetupProgressSchema.parse(started);
          assert(progress.status === "needs-authorization");
          const link = new URL(progress.authorizationUrl);
          expect(link.origin + link.pathname).toBe(oauthAuth.authorizationEndpoint);
          const callbackUrl = `https://example.com/api/http/${encodeURIComponent(`user:${scope.userId}`)}/oauth/callback`;
          expect(link.searchParams.get("redirect_uri")).toBe(callbackUrl);
          // The callback announced before credentials exist is the one consent uses.
          expect(announced.instructions).toContain(callbackUrl);
          expect(progress.instructions).toContain(callbackUrl);
          expect(inspected).toMatchObject({
            authorization: { status: "missing" },
            nextSteps: ["Complete the pending OAuth consent; setup returns its link."],
          });
          expect(JSON.stringify(run.result)).not.toContain(oauthAuth.clientSecret);
          ctx.vars.authorizationUrl = progress.authorizationUrl;
        },
      ),
      runner.drain(),
      then.automation.event({
        scope: scope,
        where: { source: "integrations", eventType: "connection.unavailable" },
        expected: { subject: { service: "api", connectionId: "api#invoices" } },
      }),
      runner.restartObject({ binding: "API", scope }),
      then.assert(
        "checking after restart resumes the persisted link instead of starting another flow",
        async (ctx) => {
          const run = await ctx.runCodemode({
            scope,
            code: `async () => ({
              checked: await integrations.setup({ kind: "check", connectionId: "api#invoices" }),
              resubmitted: await integrations.setup({ kind: "input", connectionId: "api#invoices", input: { start: true } }),
            })`,
          });
          expect(run.result).toEqual({
            checked: {
              status: "needs-authorization",
              connectionId: "api#invoices",
              instructions: expect.any(String),
              authorizationUrl: ctx.vars.authorizationUrl,
            },
            resubmitted: {
              status: "needs-authorization",
              connectionId: "api#invoices",
              instructions: expect.any(String),
              authorizationUrl: ctx.vars.authorizationUrl,
            },
          });
        },
      ),
      then.assert(
        "a native restart leaves several pending links and any of them completes setup",
        async (ctx) => {
          const run = await ctx.runCodemode({
            scope,
            code: `async () => {
              const native = await api.startOAuth({ slug: "invoices" });
              const checked = await integrations.setup({ kind: "check", connectionId: "api#invoices" });
              return { native, checked };
            }`,
          });
          const { native, checked } = run.result as {
            native: { authorizationUrl: string };
            checked: { status: string; authorizationUrl: string };
          };
          assert(checked.status === "needs-authorization");
          expect([ctx.vars.authorizationUrl, native.authorizationUrl]).toContain(
            checked.authorizationUrl,
          );
          // The integration's original link remains valid after the native restart.
          await completeConsent(ctx, scope, ctx.vars.authorizationUrl, "first-consent");
          const ready = await ctx.runCodemode({
            scope,
            code: `async () => ({
              checked: await integrations.setup({ kind: "check", connectionId: "api#invoices" }),
              inspected: await integrations.get({ connectionId: "api#invoices" }),
              result: await integrations.execute({ connectionId: "api#invoices", actionId: "request", input: {
                method: "GET", path: "/invoices", body: { type: "empty" },
              } }),
            })`,
          });
          expect(ready.result).toMatchObject({
            checked: { status: "ready", connectionId: "api#invoices" },
            inspected: { authorization: { status: "available" }, nextSteps: [] },
            result: { ok: true },
          });
          expect(provider.codeExchanges).toEqual(["first-consent"]);
          expect(provider.requests).toEqual([
            { method: "GET", path: "/invoices", authorization: "Bearer access-first-consent" },
          ]);
        },
      ),
      runner.drain(),
      then.automation.event({
        scope: scope,
        where: { source: "integrations", eventType: "connection.ready" },
        expected: { subject: { service: "api", connectionId: "api#invoices" } },
      }),
      then.assert(
        "reauthorizing discards working tokens until the new consent completes",
        async (ctx) => {
          const run = await ctx.runCodemode({
            scope,
            code: `async () => {
              const target = { connectionId: "api#invoices" };
              const check = await integrations.reconfigure({ ...target, kind: "check" });
              const restarted = await integrations.reconfigure({ ...target, kind: "input", input: { reauthorize: true } });
              return {
                check, restarted,
                inspected: await integrations.get(target),
                resumed: await integrations.setup({ ...target, kind: "check" }),
              };
            }`,
          });
          const { check, restarted, resumed } = run.result as {
            check: { instructions: string; inputSchema: unknown };
            restarted: { status: string; authorizationUrl: string };
            resumed: { authorizationUrl: string };
          };
          expect(check.instructions).toContain("reauthorize");
          expect(JSON.stringify(check.inputSchema)).toContain('"reauthorize"');
          assert(restarted.status === "needs-authorization");
          expect(restarted.authorizationUrl).not.toBe(ctx.vars.authorizationUrl);
          expect(run.result).toMatchObject({ inspected: { authorization: { status: "missing" } } });
          expect(resumed.authorizationUrl).toBe(restarted.authorizationUrl);

          await completeConsent(ctx, scope, restarted.authorizationUrl, "second-consent");
          const ready = await ctx.runCodemode({
            scope,
            code: `async () => ({
              checked: await integrations.setup({ kind: "check", connectionId: "api#invoices" }),
              result: await integrations.execute({ connectionId: "api#invoices", actionId: "request", input: {
                method: "GET", path: "/invoices", body: { type: "empty" },
              } }),
            })`,
          });
          expect(ready.result).toMatchObject({
            checked: { status: "ready" },
            result: { ok: true },
          });
          expect(provider.requests.at(-1)).toEqual({
            method: "GET",
            path: "/invoices",
            authorization: "Bearer access-second-consent",
          });
        },
      ),
      then.assert(
        "an expired token without a refresh token requires explicit consent again",
        async (ctx) => {
          provider.control.expiresIn = 1;
          provider.control.refreshToken = false;
          const started = await ctx.runCodemode({
            scope,
            code: `async () => await integrations.setup({ kind: "input", connectionId: "api#short-lived", input: {
              baseUrl: ${JSON.stringify(providerOrigin)}, ...${JSON.stringify(oauthAuth)},
            } })`,
          });
          const progress = integrationSetupProgressSchema.parse(started.result);
          assert(progress.status === "needs-authorization");
          await completeConsent(ctx, scope, progress.authorizationUrl, "short-consent");
          const run = await ctx.runCodemode({
            scope,
            code: `async () => {
              const target = { connectionId: "api#short-lived" };
              const inspected = await integrations.get(target);
              const check = await integrations.setup({ ...target, kind: "check" });
              const restarted = await integrations.setup({ ...target, kind: "input", input: { start: true } });
              return { inspected, check, restarted };
            }`,
          });
          expect(run.result).toMatchObject({
            inspected: {
              authorization: { status: "expired" },
              nextSteps: ["Run setup to start OAuth consent again."],
            },
            check: {
              status: "needs-input",
              instructions: expect.stringMatching(
                /expired.*\/api\/http\/user%3Aapi-user\/oauth\/callback/,
              ),
              secretFields: [],
            },
            restarted: { status: "needs-authorization" },
          });
          const { restarted } = run.result as { restarted: { authorizationUrl: string } };
          expect(restarted.authorizationUrl).not.toBe(progress.authorizationUrl);
          expect(provider.codeExchanges).toEqual([
            "first-consent",
            "second-consent",
            "short-consent",
          ]);
          ctx.vars.authorizationUrl = restarted.authorizationUrl;
        },
      ),
      runner.restartObject({ binding: "API", scope }),
      then.assert(
        "renewed consent outranks the expired token and resumes after restart",
        async (ctx) => {
          const run = await ctx.runCodemode({
            scope,
            code: `async () => {
              const target = { connectionId: "api#short-lived" };
              return {
                inspected: await integrations.get(target),
                checked: await integrations.setup({ ...target, kind: "check" }),
                resubmitted: await integrations.setup({ ...target, kind: "input", input: { start: true } }),
              };
            }`,
          });
          expect(run.result).toMatchObject({
            inspected: {
              authorization: { status: "missing" },
              nextSteps: ["Complete the pending OAuth consent; setup returns its link."],
            },
            checked: { status: "needs-authorization", authorizationUrl: ctx.vars.authorizationUrl },
            resubmitted: {
              status: "needs-authorization",
              authorizationUrl: ctx.vars.authorizationUrl,
            },
          });

          provider.control.expiresIn = 3600;
          await completeConsent(ctx, scope, ctx.vars.authorizationUrl, "renewed-consent");
          const ready = await ctx.runCodemode({
            scope,
            code: `async () => ({
              checked: await integrations.setup({ kind: "check", connectionId: "api#short-lived" }),
              result: await integrations.execute({ connectionId: "api#short-lived", actionId: "request", input: {
                method: "GET", path: "/invoices", body: { type: "empty" },
              } }),
            })`,
          });
          expect(ready.result).toMatchObject({
            checked: { status: "ready" },
            result: { ok: true },
          });
          expect(provider.requests.at(-1)).toEqual({
            method: "GET",
            path: "/invoices",
            authorization: "Bearer access-renewed-consent",
          });
          expect(provider.codeExchanges).toHaveLength(4);
        },
      ),
    ],
  }));
});

test("api addresses resolve only in their own scope, page natively, and require both authority layers", async () => {
  const projectScope = {
    kind: "project",
    orgId: orgScope.orgId,
    projectId: "api-project",
  } as const;
  const userScope = { kind: "user", userId: "api-member" } as const;
  await runApiIntegrationScenario((provider) => ({
    name: "API integration scope isolation, pagination, and authorization",
    setup: ({ given }) => [
      given.organization.exists({ id: orgScope.orgId, slug: "api-org", name: "API Org" }),
      given.auth.user({ id: userScope.userId, email: "member@example.test" }),
    ],
    steps: ({ then }) => [
      then.assert(
        "the same address is independent in organization, project, user, and system scopes",
        async (ctx) => {
          const create = `async () => await integrations.setup({ kind: "input", connectionId: "api#shared", input: {
            type: "none", baseUrl: ${JSON.stringify(providerOrigin)},
          } })`;
          const created = await ctx.runCodemode({ scope: orgScope, code: create });
          expect(created.result).toEqual({ status: "ready", connectionId: "api#shared" });
          for (const scope of [projectScope, userScope]) {
            const run = await ctx.runCodemode({
              scope,
              code: `async () => await integrations.get({ connectionId: "api#shared" })`,
            });
            expect(run.result).toMatchObject({ configuration: { status: "missing" } });
          }
          const listed = await ctx.runCodemode({
            scope: orgScope,
            code: `async () => await integrations.list({ cursor: null })`,
          });
          expect(listed.result).toMatchObject({
            connections: [
              { connectionId: "api#shared", authorization: { status: "not-required" } },
            ],
          });

          const system = createIntegrationScenarioTerminal(
            ctx.runtime.services,
            createBackofficeSystemExecution({ kind: "system" }),
            new BackofficeKernel(ctx.runtime.services),
          );
          const discovered = await system.exec("integrations.discover --json");
          expect(discovered.exitCode, discovered.stderr).toBe(0);
          expect(JSON.parse(discovered.stdout)).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: "api",
                availability: expect.objectContaining({ status: "unavailable" }),
              }),
            ]),
          );
          const setup = await system.exec("integrations.setup --connection-id 'api#shared' --json");
          expect(setup.exitCode, setup.stderr).toBe(0);
          expect(JSON.parse(setup.stdout)).toMatchObject({ status: "blocked" });
          expect(await system.exec("integrations.get --connection-id 'api#shared'")).toMatchObject({
            exitCode: 1,
          });
        },
      ),
      then.assert(
        "listing forwards native cursor pages without loading every connection",
        async (ctx) => {
          const run = await ctx.runCodemode({
            scope: projectScope,
            code: `async () => {
              for (let index = 0; index < 51; index++) {
                await api.createConnection({ slug: "conn-" + String(index).padStart(2, "0"), baseUrl: ${JSON.stringify(providerOrigin)} });
              }
              const pages = [];
              let cursor = null;
              do {
                const page = await integrations.list({ cursor });
                pages.push(page.connections.map((connection) => connection.connectionId));
                cursor = page.cursor;
              } while (cursor !== null);
              return pages;
            }`,
          });
          const pages = run.result as string[][];
          expect(pages[0]).toHaveLength(50);
          expect(pages.flat()).toEqual(
            Array.from({ length: 51 }, (_, index) => `api#conn-${String(index).padStart(2, "0")}`),
          );
        },
      ),
      then.assert("umbrella permissions never replace native API permissions", async (ctx) => {
        const setupOnly = createDelegatedExecution(ctx, orgScope, provider, [
          BACKOFFICE_PERMISSION.integrations.manage,
          BACKOFFICE_PERMISSION.api.connectionsRead,
          BACKOFFICE_PERMISSION.upload.read,
        ]);
        const setupTerminal = createIntegrationScenarioTerminal(
          ctx.runtime.services,
          setupOnly.execution,
          setupOnly.kernel,
        );
        const denied = await setupTerminal.exec(
          `integrations.setup --connection-id 'api#denied' --input-json '${JSON.stringify({ type: "none", baseUrl: providerOrigin })}'`,
        );
        expect(denied).toMatchObject({
          exitCode: 1,
          stderr: expect.stringContaining("required capability grant"),
        });
        // Umbrella management does not carry the native delete permission.
        expect(
          await setupTerminal.exec(
            "integrations.disconnect --connection-id 'api#shared' --confirm 'api#shared'",
          ),
        ).toMatchObject({
          exitCode: 1,
          stderr: expect.stringContaining("required capability grant"),
        });

        const command = `integrations.execute --connection-id 'api#shared' --action-id request --input-json '${JSON.stringify({ method: "GET", path: "/invoices", body: { type: "empty" } })}'`;
        const executeOnly = createDelegatedExecution(ctx, orgScope, provider, [
          BACKOFFICE_PERMISSION.integrations.execute,
          BACKOFFICE_PERMISSION.api.requestsExecute,
          BACKOFFICE_PERMISSION.upload.read,
        ]);
        // Resolution reads the connection name, so execution also needs connection-read authority.
        expect(
          await createIntegrationScenarioTerminal(
            ctx.runtime.services,
            executeOnly.execution,
            executeOnly.kernel,
          ).exec(command),
        ).toMatchObject({
          exitCode: 1,
          stderr: expect.stringContaining("required capability grant"),
        });

        const delegated = createDelegatedExecution(ctx, orgScope, provider, [
          BACKOFFICE_PERMISSION.integrations.execute,
          BACKOFFICE_PERMISSION.api.connectionsRead,
          BACKOFFICE_PERMISSION.api.requestsExecute,
          BACKOFFICE_PERMISSION.upload.read,
        ]);
        const executed = await createIntegrationScenarioTerminal(
          ctx.runtime.services,
          delegated.execution,
          delegated.kernel,
        ).exec(`${command} --print ok`);
        expect(executed.exitCode, executed.stderr).toBe(0);
        assert(executed.stdout === "true\n");
        expect(provider.requests).toHaveLength(1);

        // A resolved connection does not retain authority revoked before the action runs.
        const resolved = await createApiIntegration({ runtime: ctx.runtime.services }).resolve(
          { kernel: delegated.kernel, execution: delegated.execution },
          "shared",
        );
        const [action] = await resolved.actions();
        assert(action);
        provider.delegatedGrants.splice(
          provider.delegatedGrants.indexOf(BACKOFFICE_PERMISSION.api.requestsExecute),
          1,
        );
        await expect(
          action.invoke({ method: "GET", path: "/invoices", body: { type: "empty" } }),
        ).rejects.toMatchObject({ name: "BackofficeForbiddenError" });
        expect(provider.requests).toHaveLength(1);
        assert(
          (await ctx.runtime.objects.api
            .for(orgScope)
            .http.fetchAuthorized(new Request("https://api.do/api/api/connections/denied"), {
              execution: createBackofficeSystemExecution(orgScope),
            })
            .then((response) => response.status)) === 404,
        );
      }),
    ],
  }));
});
