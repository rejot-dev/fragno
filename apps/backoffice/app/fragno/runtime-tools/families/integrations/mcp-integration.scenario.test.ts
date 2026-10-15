import { assert, expect, test, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { automationEventListResultSchema } from "@fragno-dev/backoffice-api/v0/events";
import { integrationSetupProgressSchema } from "@fragno-dev/backoffice-api/v0/integrations";
import {
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { createTestMcpServer, type TestMcpServer } from "@fragno-dev/mcp-fragment/testing";

import { withBackofficeActorCapabilityGrants } from "@/backoffice-runtime/authority-resolver";
import {
  createBackofficeSystemExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
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
import { InMemoryAppInstallationsObject } from "../../../../../workers/app-installations.do";
import { InMemoryAppsObject } from "../../../../../workers/apps.do";
import { InMemoryAuthObject } from "../../../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../../../workers/automations.do";
import { InMemoryCodemodeObject } from "../../../../../workers/codemode.do";
import { InMemoryFormsObject } from "../../../../../workers/forms.do";
import { InMemoryGitHubWebhookRouterObject } from "../../../../../workers/github-webhook-router.do";
import { InMemoryGitHubObject } from "../../../../../workers/github.do";
import { InMemoryMcpObject } from "../../../../../workers/mcp.do";
import { InMemoryOtpObject } from "../../../../../workers/otp.do";
import { InMemoryProjectConnectorObject } from "../../../../../workers/project-connector.do";
import { InMemoryResendObject } from "../../../../../workers/resend.do";
import { InMemoryReson8Object } from "../../../../../workers/reson8.do";
import { InMemoryTelegramObject } from "../../../../../workers/telegram.do";
import { InMemoryUploadObject } from "../../../../../workers/upload.do";
import { createMcpIntegration } from "./mcp-integration";
const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  APPS: (input) => new InMemoryAppsObject(input),
  APP_INSTALLATIONS: (input) => new InMemoryAppInstallationsObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  CODEMODE: (input) => new InMemoryCodemodeObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  PROJECT_CONNECTOR: (input) => new InMemoryProjectConnectorObject(input),
  RESEND: (input) => new InMemoryResendObject(input),
  RESON8: (input) => new InMemoryReson8Object(input),
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
  GITHUB: (input) => new InMemoryGitHubObject(input),
  GITHUB_WEBHOOK_ROUTER: (input) => new InMemoryGitHubWebhookRouterObject(input),
  OTP: (input) => new InMemoryOtpObject(input),
} satisfies LocalBackofficeObjects;

const orgScope = { kind: "org", orgId: "mcp-org" } as const;
const toolsOrigin = "https://tools.provider.test";
const oauthOrigin = "https://oauth.provider.test";
const staticOrigin = "https://static.provider.test";
const expiringOrigin = "https://expiring.provider.test";
const toolsToken = "tools-token";
const draft07 = "http://json-schema.org/draft-07/schema#";

const delegatedActor = {
  scope: "internal",
  type: "agent",
  id: "mcp-integration-agent",
  role: "assistant",
} as const;

type McpProviders = {
  /** Tool invocations that reached a server, by tool name. */
  calls: string[];
  oauth: TestMcpServer;
  static: TestMcpServer;
  /** Consent grants an hour-long access token without a refresh token. */
  expiring: TestMcpServer;
  /** Grants the delegated actor holds at both the caller and the receiving MCP object. */
  delegatedGrants: BackofficePermissionRequirement[];
};

function createToolsServer(calls: string[]) {
  return createTestMcpServer({
    protocolVersion: "2026-07-28",
    requiredBearerToken: toolsToken,
    enableJsonResponse: true,
    tools: [
      {
        name: "echo",
        title: "Echo",
        description: "Echo a message.",
        inputSchema: {
          $schema: draft07,
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        outputSchema: {
          $schema: draft07,
          type: "object",
          properties: { echoed: { type: "string" } },
          required: ["echoed"],
        },
        call: ({ text }) => {
          calls.push("echo");
          return {
            content: [{ type: "text", text: String(text) }],
            structuredContent: { echoed: String(text) },
          };
        },
      },
      {
        name: "refuse",
        description: "Always reports a tool error.",
        inputSchema: { type: "object", properties: {} },
        call: () => {
          calls.push("refuse");
          return { isError: true, content: [{ type: "text", text: "Quota exhausted for today." }] };
        },
      },
      {
        name: "drift",
        description: "Returns structured content that violates its declared output schema.",
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
        },
        call: () => {
          calls.push("drift");
          return { content: [], structuredContent: { count: "many" } };
        },
      },
      {
        name: "legacy",
        description: "Publishes a draft-04 schema that cannot be validated faithfully.",
        inputSchema: { $schema: "http://json-schema.org/draft-04/schema#", type: "object" },
        call: () => {
          calls.push("legacy");
          return { content: [] };
        },
      },
    ],
  });
}

/** In-memory storage follows the scenario clock; SQLite's `now` is the real one. */
async function runMcpIntegrationScenario<TVars extends Record<string, unknown>>(
  storage: "sqlite" | "memory",
  defineScenario: (
    providers: McpProviders,
  ) => Omit<BackofficeScenarioDefinitionInput<TVars>, "objects">,
) {
  const calls: string[] = [];
  const providers: McpProviders = {
    calls,
    oauth: createTestMcpServer({
      protocolVersion: "2026-07-28",
      oauth: true,
      enableJsonResponse: true,
      requiredBearerToken: "oauth-access-token",
    }),
    static: createTestMcpServer({
      protocolVersion: "2026-07-28",
      oauth: true,
      enableJsonResponse: true,
      requiredBearerToken: "static-access-token",
      disableDynamicRegistration: true,
      requiredClientId: "static-client",
      requiredClientSecret: "static-secret",
    }),
    expiring: createTestMcpServer({
      protocolVersion: "2026-07-28",
      oauth: true,
      enableJsonResponse: true,
      requiredBearerToken: "expiring-access-token",
      omitRefreshTokenOnConsent: true,
    }),
    delegatedGrants: [],
  };
  const servers = new Map([
    [toolsOrigin, createToolsServer(calls)],
    [oauthOrigin, providers.oauth],
    [staticOrigin, providers.static],
    [expiringOrigin, providers.expiring],
  ]);
  const serverFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const server = servers.get(new URL(request.url).origin);
    assert(server, `Unexpected MCP provider request to ${request.url}`);
    return await server.fetch(request);
  };
  const directory = await mkdtemp(path.join(tmpdir(), "backoffice-mcp-integration-"));
  try {
    const scenario = defineScenario(providers);
    await runBackofficeScenario(
      defineBackofficeScenario({
        ...scenario,
        options: {
          ...scenario.options,
          sqliteDataDirectory: storage === "sqlite" ? directory : undefined,
        },
        objects: {
          ...scenarioObjects,
          MCP: (options) =>
            new InMemoryMcpObject({
              ...options,
              runtime: {
                ...options.runtime,
                authorityResolver: withBackofficeActorCapabilityGrants({
                  resolver: options.runtime.authorityResolver,
                  actor: delegatedActor,
                  grants: providers.delegatedGrants,
                }),
              },
              fetch: serverFetch,
            }),
        },
      }),
    );
  } finally {
    await Promise.all([...servers.values()].map((server) => server.close()));
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
  providers: McpProviders,
  grants: readonly BackofficePermissionRequirement[],
) {
  providers.delegatedGrants.splice(0, providers.delegatedGrants.length, ...grants);
  const system = createBackofficeSystemExecution(scope);
  return {
    execution: { ...system, actors: { ...system.actors, delegation: [delegatedActor] } },
    kernel: new BackofficeKernel({
      ...ctx.runtime.services,
      authorityResolver: withBackofficeActorCapabilityGrants({
        resolver: ctx.runtime.services.authorityResolver,
        actor: delegatedActor,
        grants: providers.delegatedGrants,
      }),
    }),
  };
}

/** Every connection event recorded for one address, sorted so repeated states can be counted. */
async function connectionEventTypes(
  ctx: BackofficeScenarioContext,
  scope: BackofficeContextScope,
  connectionId: string,
) {
  const response = await ctx.runtime.objects.automations
    .for(scope)
    .http.fetch(new Request("https://automations.test/api/automations/events?limit=500"));
  assert(response.ok, await response.clone().text());
  return automationEventListResultSchema
    .parse(await response.json())
    .events.filter(
      (event) => event.source === "integrations" && event.subject?.connectionId === connectionId,
    )
    .map((event) => event.eventType)
    .sort();
}

/** Consent happens at the provider; its redirect to the scope's callback is all setup sees. */
async function completeConsent(
  ctx: BackofficeScenarioContext,
  scope: BackofficeContextScope & { kind: "user" | "org" | "project" },
  provider: TestMcpServer,
  authorizationUrl: string,
) {
  const authorize = await provider.fetch(new Request(authorizationUrl));
  const location = authorize.headers.get("location");
  assert(location, "Provider consent must redirect to the callback");
  const callback = await ctx.runtime.objects.mcp
    .for(scope)
    .http.fetch(new Request(`https://mcp.do/api/mcp/oauth/callback${new URL(location).search}`));
  assert(callback.ok, await callback.clone().text());
}

test("Codemode registers an MCP server through setup, publishes its tools as actions, and keeps one address through reset, replacement, and disconnect", async () => {
  await runMcpIntegrationScenario("sqlite", (providers) => ({
    name: "MCP bearer setup, tool actions, and lifecycle through the registered facade",
    setup: ({ given }) => [
      given.organization.exists({ id: orgScope.orgId, slug: "mcp-org", name: "MCP Org" }),
    ],
    steps: ({ then, runner }) => [
      then.assert(
        "an empty scope advertises the service and setup checks create nothing",
        async (ctx) => {
          const run = await ctx.runCodemode({
            scope: orgScope,
            code: `async () => ({
              services: await integrations.discover(),
              check: await integrations.setup({ kind: "check", connectionId: "mcp#tools" }),
              invalid: await integrations.setup({ kind: "check", connectionId: "mcp#Tools" }),
              page: await integrations.list({ cursor: null }),
            })`,
            assertToolCalls: ["integrations.discover", "integrations.setup", "integrations.list"],
          });
          expect(run.result).toMatchObject({
            services: expect.arrayContaining([
              {
                id: "mcp",
                label: "MCP server",
                description: expect.stringContaining("mcp#<slug>"),
                connectionCardinality: "multiple",
                availability: { status: "available" },
                setupTargets: [],
                automationEvents: expect.arrayContaining([
                  { source: "mcp", eventType: "server.configuration.changed" },
                ]),
              },
            ]),
            check: {
              status: "needs-input",
              connectionId: "mcp#tools",
              instructions: expect.stringContaining(
                "https://example.com/api/mcp/org%3Amcp-org/oauth/callback",
              ),
              secretFields: ["token", "clientSecret"],
            },
            invalid: { status: "blocked", connectionId: "mcp#Tools" },
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
        },
      ),
      then.assert(
        "setup stores the token once and the source's tool discovery publishes validated actions",
        async (ctx) => {
          const ready = await ctx.runCodemode({
            scope: orgScope,
            code: `async () => {
              const target = { connectionId: "mcp#tools" };
              return {
                ready: await integrations.setup({ ...target, kind: "input", input: {
                  type: "bearer", name: "Tools", endpointUrl: ${JSON.stringify(`${toolsOrigin}/mcp`)}, token: ${JSON.stringify(toolsToken)},
                } }),
                repeated: await integrations.setup({ ...target, kind: "input", input: {
                  type: "bearer", endpointUrl: ${JSON.stringify(`${toolsOrigin}/mcp`)}, token: "must-not-replace",
                } }),
              };
            }`,
          });
          expect(ready.result).toEqual({
            ready: { status: "ready", connectionId: "mcp#tools" },
            repeated: { status: "ready", connectionId: "mcp#tools" },
          });
          // Ready reflects auth; tools arrive through the source's background refresh.
          await ctx.drain();
          const run = await ctx.runCodemode({
            scope: orgScope,
            code: `async () => {
              const target = { connectionId: "mcp#tools" };
              const actions = await integrations.actions(target);
              const echoed = await integrations.execute({ ...target, actionId: "echo", input: { text: "hello" } });
              const refused = await integrations.execute({ ...target, actionId: "refuse", input: {} });
              const failures = {};
              for (const [name, attempt] of [
                ["invalidInput", () => integrations.execute({ ...target, actionId: "echo", input: { text: 1 } })],
                ["drift", () => integrations.execute({ ...target, actionId: "drift", input: {} })],
                ["legacy", () => integrations.execute({ ...target, actionId: "legacy", input: {} })],
              ]) {
                try { await attempt(); failures[name] = "accepted"; } catch (error) { failures[name] = error.message; }
              }
              return {
                actions, echoed, refused, failures,
                inspected: await integrations.get(target),
                page: await integrations.list({ cursor: null }),
              };
            }`,
          });
          expect(run.result).toMatchObject({
            actions: [
              {
                id: "echo",
                label: "Echo",
                // Draft-07 contracts are published as the server declared them.
                inputSchema: { $schema: draft07, required: ["text"] },
                outputSchema: {
                  type: "object",
                  required: ["isError", "content", "structuredContent"],
                },
              },
              { id: "refuse" },
              { id: "drift" },
            ],
            echoed: {
              isError: false,
              content: [{ type: "text", text: "hello" }],
              structuredContent: { echoed: "hello" },
            },
            // A tool error is the server's answer, returned rather than thrown.
            refused: {
              isError: true,
              content: [{ type: "text", text: "Quota exhausted for today." }],
              structuredContent: null,
            },
            failures: {
              invalidInput: expect.stringContaining("failed its published JSON Schema"),
              drift: expect.stringContaining("must not be automatically retried"),
              legacy: expect.stringContaining("action not found"),
            },
            inspected: {
              connectionId: "mcp#tools",
              integrationId: "mcp",
              name: "Tools",
              configuration: { status: "configured" },
              authorization: { status: "available" },
              checks: [{ id: "tools.list", status: "not-checked" }],
              nextSteps: [expect.stringContaining("Tools legacy publish schemas")],
            },
            page: {
              connections: [
                {
                  connectionId: "mcp#tools",
                  name: "Tools",
                  authorization: { status: "not-checked" },
                },
              ],
            },
          });
          expect((run.result as { actions: unknown[] }).actions).toHaveLength(3);
          expect(JSON.stringify(run.result)).not.toContain(toolsToken);
          // Invalid input and unpublished tools never reach the server; drift already ran.
          expect(providers.calls).toEqual(["echo", "refuse", "drift"]);
        },
      ),
      runner.drain(),
      then.automation.event({
        scope: orgScope,
        where: { source: "integrations", eventType: "connection.ready" },
        expected: { subject: { service: "mcp", connectionId: "mcp#tools" } },
      }),
      runner.drain(),
      then.automation.event({
        scope: orgScope,
        where: { source: "mcp", eventType: "server.configuration.changed" },
        expected: { subject: { connectionId: "mcp#tools" } },
      }),
      runner.restartObject({ binding: "MCP", scope: orgScope }),
      then.assert("verification lists the tools live and records nothing", async (ctx) => {
        const run = await ctx.runCodemode({
          scope: orgScope,
          code: `async () => ({
            checked: await integrations.verify({ connectionId: "mcp#tools" }),
            inspected: await integrations.get({ connectionId: "mcp#tools" }),
          })`,
        });
        expect(run.result).toMatchObject({
          checked: {
            checks: [
              {
                id: "tools.list",
                status: "passed",
                checkedAt: expect.any(String),
                message: "The server listed 4 tools. Calling them has not been tested.",
              },
            ],
          },
          inspected: { checks: [{ status: "not-checked" }] },
        });
        expect(providers.calls).toHaveLength(3);
      }),
      then.assert(
        "a native credential reset asks for a new token instead of becoming unauthenticated",
        async (ctx) => {
          const cleared = await ctx.runtime.objects.mcp
            .for(orgScope)
            .http.fetchAuthorized(
              new Request("https://mcp.do/api/mcp/servers/tools/auth", { method: "DELETE" }),
              { execution: createBackofficeSystemExecution(orgScope) },
            );
          assert(cleared.ok, await cleared.clone().text());
          const run = await ctx.runCodemode({
            scope: orgScope,
            code: `async () => {
              const target = { connectionId: "mcp#tools" };
              const inspected = await integrations.get(target);
              const check = await integrations.setup({ ...target, kind: "check" });
              const ready = await integrations.setup({ ...target, kind: "input", input: { token: ${JSON.stringify(toolsToken)} } });
              return { inspected, check, ready, actions: await integrations.actions(target) };
            }`,
          });
          expect(run.result).toMatchObject({
            inspected: {
              authorization: { status: "missing" },
              nextSteps: ["Run setup to provide a bearer token."],
            },
            check: { status: "needs-input", secretFields: ["token"] },
            ready: { status: "ready" },
            // New credentials drop the tool cache until the source rediscovers it.
            actions: [],
          });
          await ctx.drain();
          const echoed = await ctx.runCodemode({
            scope: orgScope,
            code: `async () => await integrations.execute({ connectionId: "mcp#tools", actionId: "echo", input: { text: "again" } })`,
          });
          expect(echoed.result).toMatchObject({ structuredContent: { echoed: "again" } });
        },
      ),
      runner.drain(),
      then.automation.event({
        scope: orgScope,
        where: { source: "integrations", eventType: "connection.unavailable" },
        expected: { subject: { service: "mcp", connectionId: "mcp#tools" } },
      }),
      then.assert(
        "reconfiguration from the stored settings replaces the server in place and disconnect requires confirmation",
        async (ctx) => {
          const run = await ctx.runCodemode({
            scope: orgScope,
            // Like an agent asked to drop the auth, it knows neither the endpoint nor the name.
            code: `async () => {
              const target = { connectionId: "mcp#tools" };
              const check = await integrations.reconfigure({ ...target, kind: "check" });
              const { settings } = await integrations.get(target);
              const replaced = await integrations.reconfigure({ ...target, kind: "input", input: {
                ...settings, type: "none",
              } });
              const renamed = await integrations.get(target);
              let unconfirmed = "accepted";
              try { await integrations.disconnect({ ...target, confirm: "mcp#other" }); }
              catch { unconfirmed = "rejected"; }
              return {
                check, settings, replaced, renamed, unconfirmed,
                disconnected: await integrations.disconnect({ ...target, confirm: "mcp#tools" }),
                repeated: await integrations.disconnect({ ...target, confirm: "mcp#tools" }),
                after: await integrations.get(target),
                setup: await integrations.setup({ ...target, kind: "check" }),
              };
            }`,
            assertToolCalls: [
              "integrations.reconfigure",
              "integrations.get",
              "integrations.disconnect",
              "integrations.setup",
            ],
          });
          expect(run.result).toMatchObject({
            // Only OAuth servers can consent again without a full replacement.
            check: {
              status: "needs-input",
              instructions: expect.not.stringContaining("reauthorize"),
            },
            settings: { name: "Tools", endpointUrl: `${toolsOrigin}/mcp`, type: "bearer" },
            replaced: { status: "ready", connectionId: "mcp#tools" },
            renamed: {
              name: "Tools",
              authMethod: "none",
              authorization: { status: "not-required" },
              settings: { name: "Tools", endpointUrl: `${toolsOrigin}/mcp`, type: "none" },
            },
            unconfirmed: "rejected",
            disconnected: { connectionId: "mcp#tools", status: "disconnected" },
            repeated: { connectionId: "mcp#tools", status: "not-configured" },
            after: {
              name: "tools",
              configuration: { status: "missing", missingFields: ["endpointUrl", "type"] },
              settings: null,
            },
            setup: { status: "needs-input" },
          });
        },
      ),
      runner.drain(),
      then.automation.event({
        scope: orgScope,
        where: { source: "integrations", eventType: "connection.disconnected" },
        expected: { subject: { service: "mcp", connectionId: "mcp#tools" } },
      }),
    ],
  }));
});

test("OAuth setup resumes source-owned consent, reauthorizes, and recovers from failed client registration", async () => {
  const scope = { kind: "user", userId: "mcp-user" } as const;
  await runMcpIntegrationScenario<{ authorizationUrl: string }>("sqlite", (providers) => ({
    name: "MCP OAuth setup through the registered facade",
    setup: ({ given }) => [given.auth.user({ id: scope.userId, email: "mcp@example.test" })],
    vars: () => ({ authorizationUrl: "" }),
    steps: ({ then, runner }) => [
      then.assert(
        "submitting an OAuth configuration registers the server and starts consent",
        async (ctx) => {
          const run = await ctx.runCodemode({
            scope,
            code: `async () => {
              const target = { connectionId: "mcp#docs" };
              const started = await integrations.setup({ ...target, kind: "input", input: {
                type: "oauth", name: "Docs", endpointUrl: ${JSON.stringify(`${oauthOrigin}/mcp`)},
              } });
              return { started, inspected: await integrations.get(target), actions: await integrations.actions(target) };
            }`,
          });
          const { started, inspected, actions } = run.result as {
            started: unknown;
            inspected: unknown;
            actions: unknown[];
          };
          const progress = integrationSetupProgressSchema.parse(started);
          assert(progress.status === "needs-authorization");
          expect(new URL(progress.authorizationUrl).searchParams.get("redirect_uri")).toBe(
            `https://example.com/api/mcp/${encodeURIComponent(`user:${scope.userId}`)}/oauth/callback`,
          );
          expect(inspected).toMatchObject({
            authorization: { status: "missing" },
            nextSteps: ["Complete the pending OAuth consent; setup returns its link."],
          });
          expect(actions).toEqual([]);
          ctx.vars.authorizationUrl = progress.authorizationUrl;
        },
      ),
      runner.drain(),
      then.automation.event({
        scope: scope,
        where: { source: "integrations", eventType: "connection.unavailable" },
        expected: { subject: { service: "mcp", connectionId: "mcp#docs" } },
      }),
      runner.restartObject({ binding: "MCP", scope }),
      then.assert(
        "checks after restart resume the retained link and consent publishes the tools",
        async (ctx) => {
          const resumed = await ctx.runCodemode({
            scope,
            code: `async () => ({
              checked: await integrations.setup({ kind: "check", connectionId: "mcp#docs" }),
              resubmitted: await integrations.setup({ kind: "input", connectionId: "mcp#docs", input: { start: true } }),
            })`,
          });
          expect(resumed.result).toMatchObject({
            checked: { status: "needs-authorization", authorizationUrl: ctx.vars.authorizationUrl },
            resubmitted: {
              status: "needs-authorization",
              authorizationUrl: ctx.vars.authorizationUrl,
            },
          });
          await completeConsent(ctx, scope, providers.oauth, ctx.vars.authorizationUrl);
          await ctx.drain();
          const ready = await ctx.runCodemode({
            scope,
            code: `async () => ({
              checked: await integrations.setup({ kind: "check", connectionId: "mcp#docs" }),
              echoed: await integrations.execute({ connectionId: "mcp#docs", actionId: "echo", input: { text: "consented" } }),
            })`,
          });
          expect(ready.result).toMatchObject({
            checked: { status: "ready", connectionId: "mcp#docs" },
            echoed: { isError: false, structuredContent: { echoed: "consented" } },
          });
        },
      ),
      runner.drain(),
      then.automation.event({
        scope: scope,
        where: { source: "integrations", eventType: "connection.ready" },
        expected: { subject: { service: "mcp", connectionId: "mcp#docs" } },
      }),
      then.assert(
        "reauthorization discards the tokens until the new consent completes",
        async (ctx) => {
          const run = await ctx.runCodemode({
            scope,
            code: `async () => {
              const target = { connectionId: "mcp#docs" };
              const check = await integrations.reconfigure({ ...target, kind: "check" });
              const restarted = await integrations.reconfigure({ ...target, kind: "input", input: { reauthorize: true } });
              return { check, restarted, inspected: await integrations.get(target) };
            }`,
          });
          expect(run.result).toMatchObject({
            check: { status: "needs-input", instructions: expect.stringContaining("reauthorize") },
            restarted: { status: "needs-authorization" },
            inspected: { authorization: { status: "missing" } },
          });
          const { restarted } = run.result as { restarted: { authorizationUrl: string } };
          expect(restarted.authorizationUrl).not.toBe(ctx.vars.authorizationUrl);
          await completeConsent(ctx, scope, providers.oauth, restarted.authorizationUrl);
          const ready = await ctx.runCodemode({
            scope,
            code: `async () => await integrations.setup({ kind: "check", connectionId: "mcp#docs" })`,
          });
          expect(ready.result).toEqual({ status: "ready", connectionId: "mcp#docs" });
        },
      ),
      then.assert(
        "a server without dynamic registration is blocked until reconfigured with a client",
        async (ctx) => {
          const run = await ctx.runCodemode({
            scope,
            code: `async () => {
              const target = { connectionId: "mcp#static" };
              const blocked = await integrations.setup({ ...target, kind: "input", input: {
                type: "oauth", endpointUrl: ${JSON.stringify(`${staticOrigin}/mcp`)},
              } });
              const retried = await integrations.setup({ ...target, kind: "input", input: { start: true } });
              const started = await integrations.reconfigure({ ...target, kind: "input", input: {
                type: "oauth", endpointUrl: ${JSON.stringify(`${staticOrigin}/mcp`)},
                clientId: "static-client", clientSecret: "static-secret", scopes: ["tools"],
              } });
              return { blocked, retried, started };
            }`,
          });
          expect(run.result).toMatchObject({
            blocked: {
              status: "blocked",
              reason: expect.stringContaining("dynamic client registration"),
            },
            retried: { status: "blocked" },
            started: { status: "needs-authorization" },
          });
          expect(JSON.stringify(run.result)).not.toContain("static-secret");
          const { started } = run.result as { started: { authorizationUrl: string } };
          await completeConsent(ctx, scope, providers.static, started.authorizationUrl);
          await ctx.drain();
          const ready = await ctx.runCodemode({
            scope,
            code: `async () => ({
              checked: await integrations.setup({ kind: "check", connectionId: "mcp#static" }),
              echoed: await integrations.execute({ connectionId: "mcp#static", actionId: "echo", input: { text: "static" } }),
            })`,
          });
          expect(ready.result).toMatchObject({
            checked: { status: "ready" },
            echoed: { structuredContent: { echoed: "static" } },
          });
        },
      ),
    ],
  }));
});

test("an access token without a refresh token reports unavailable when it expires", async () => {
  const scope = { kind: "user", userId: "mcp-user" } as const;
  const connectionId = "mcp#expiring";
  await runMcpIntegrationScenario("memory", (providers) => ({
    name: "MCP OAuth expiry without a refresh token",
    setup: ({ given }) => [given.auth.user({ id: scope.userId, email: "mcp@example.test" })],
    steps: ({ then, when, runner }) => [
      then.assert("consent grants an hour-long token without a refresh token", async (ctx) => {
        const started = await ctx.runCodemode({
          scope,
          code: `async () => await integrations.setup({ kind: "input", connectionId: ${JSON.stringify(connectionId)}, input: {
            type: "oauth", name: "Expiring", endpointUrl: ${JSON.stringify(`${expiringOrigin}/mcp`)},
          } })`,
        });
        const progress = integrationSetupProgressSchema.parse(started.result);
        assert(progress.status === "needs-authorization");
        await completeConsent(ctx, scope, providers.expiring, progress.authorizationUrl);
      }),
      runner.drain(),
      then.assert("setup reports the pending consent, then the token", async (ctx) => {
        expect(await connectionEventTypes(ctx, scope, connectionId)).toEqual([
          "connection.ready",
          "connection.unavailable",
        ]);
      }),
      when.time.advance("30 minutes"),
      then.assert("reauthorizing replaces the token with another hour-long one", async (ctx) => {
        // Token expiry is stamped from the real clock, which the scenario's advance does not move.
        providers.expiring.setTokenLifetimeSeconds(90 * 60);
        const run = await ctx.runCodemode({
          scope,
          code: `async () => await integrations.reconfigure({ kind: "input", connectionId: ${JSON.stringify(connectionId)}, input: { reauthorize: true } })`,
        });
        const progress = integrationSetupProgressSchema.parse(run.result);
        assert(progress.status === "needs-authorization");
        await completeConsent(ctx, scope, providers.expiring, progress.authorizationUrl);
      }),
      when.time.advance("40 minutes"),
      runner.drain(),
      then.assert("the replaced token's expiry reports nothing", async (ctx) => {
        expect(await connectionEventTypes(ctx, scope, connectionId)).toEqual([
          "connection.ready",
          "connection.ready",
          "connection.unavailable",
          "connection.unavailable",
        ]);
      }),
      when.time.advance("30 minutes"),
      runner.drain(),
      then.assert("the current token's expiry reports the connection unavailable", async (ctx) => {
        expect(await connectionEventTypes(ctx, scope, connectionId)).toEqual([
          "connection.ready",
          "connection.ready",
          "connection.unavailable",
          "connection.unavailable",
          "connection.unavailable",
        ]);
      }),
    ],
  }));
});

test("mcp addresses resolve only in their own scope and require both authority layers", async () => {
  const projectScope = {
    kind: "project",
    orgId: orgScope.orgId,
    projectId: "mcp-project",
  } as const;
  const userScope = { kind: "user", userId: "mcp-member" } as const;
  await runMcpIntegrationScenario("sqlite", (providers) => ({
    name: "MCP integration scope isolation and authorization",
    setup: ({ given }) => [
      given.organization.exists({ id: orgScope.orgId, slug: "mcp-org", name: "MCP Org" }),
      given.auth.user({ id: userScope.userId, email: "member@example.test" }),
    ],
    steps: ({ then }) => [
      then.assert(
        "the same address is independent in organization, project, user, and system scopes",
        async (ctx) => {
          const created = await ctx.runCodemode({
            scope: orgScope,
            code: `async () => await integrations.setup({ kind: "input", connectionId: "mcp#shared", input: {
              type: "bearer", endpointUrl: ${JSON.stringify(`${toolsOrigin}/mcp`)}, token: ${JSON.stringify(toolsToken)},
            } })`,
          });
          expect(created.result).toEqual({ status: "ready", connectionId: "mcp#shared" });
          await ctx.drain();
          for (const scope of [projectScope, userScope]) {
            const run = await ctx.runCodemode({
              scope,
              code: `async () => ({
                inspected: await integrations.get({ connectionId: "mcp#shared" }),
                actions: await integrations.actions({ connectionId: "mcp#shared" }),
              })`,
            });
            expect(run.result).toMatchObject({
              inspected: { configuration: { status: "missing" } },
              actions: [],
            });
          }
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
                id: "mcp",
                availability: expect.objectContaining({ status: "unavailable" }),
              }),
            ]),
          );
          const setup = await system.exec("integrations.setup --connection-id 'mcp#shared' --json");
          expect(setup.exitCode, setup.stderr).toBe(0);
          expect(JSON.parse(setup.stdout)).toMatchObject({ status: "blocked" });
        },
      ),
      then.assert(
        "listing combines finished sources and pauses only at a source with more pages",
        async (ctx) => {
          // The API page creates connections directly through the Fragment.
          const api = ctx.runtime.objects.api.for(orgScope).http;
          for (let index = 0; index < 51; index++) {
            const created = await api.fetchAuthorized(
              new Request(
                `https://api.do/api/api/connections/conn-${String(index).padStart(2, "0")}`,
                {
                  method: "PUT",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    baseUrl: "https://api.provider.test",
                    auth: { type: "none" },
                  }),
                },
              ),
              { execution: createBackofficeSystemExecution(orgScope) },
            );
            assert(created.ok, await created.clone().text());
          }
          const run = await ctx.runCodemode({
            scope: orgScope,
            code: `async () => {
              const first = await integrations.list({ cursor: null });
              const second = await integrations.list({ cursor: first.cursor });
              return {
                first: { count: first.connections.length, more: first.cursor !== null },
                second: { ids: second.connections.map((connection) => connection.connectionId), cursor: second.cursor },
              };
            }`,
          });
          // The API source has a second page, so it ends the first; the rest share one page.
          expect(run.result).toEqual({
            first: { count: 50, more: true },
            second: { ids: ["api#conn-50", "mcp#shared"], cursor: null },
          });
        },
      ),
      then.assert(
        "integration grants also need connection grants at the receiving object",
        async (ctx) => {
          const setupOnly = createDelegatedExecution(ctx, orgScope, providers, [
            BACKOFFICE_PERMISSION.integrations.manage,
            BACKOFFICE_PERMISSION.connections.read,
            BACKOFFICE_PERMISSION.upload.read,
          ]);
          const denied = await createIntegrationScenarioTerminal(
            ctx.runtime.services,
            setupOnly.execution,
            setupOnly.kernel,
          ).exec(
            `integrations.setup --connection-id 'mcp#denied' --input-json '${JSON.stringify({ type: "none", endpointUrl: `${toolsOrigin}/mcp` })}'`,
          );
          expect(denied).toMatchObject({
            exitCode: 1,
            stderr: expect.stringContaining("is not granted"),
          });

          const command = `integrations.execute --connection-id 'mcp#shared' --action-id echo --input-json '${JSON.stringify({ text: "delegated" })}'`;
          const callOnly = createDelegatedExecution(ctx, orgScope, providers, [
            BACKOFFICE_PERMISSION.integrations.execute,
            BACKOFFICE_PERMISSION.upload.read,
          ]);
          // Resolution reads the server and its tools, so calls also need connection-read authority.
          expect(
            await createIntegrationScenarioTerminal(
              ctx.runtime.services,
              callOnly.execution,
              callOnly.kernel,
            ).exec(command),
          ).toMatchObject({
            exitCode: 1,
            stderr: expect.stringContaining("is not granted"),
          });

          const delegated = createDelegatedExecution(ctx, orgScope, providers, [
            BACKOFFICE_PERMISSION.integrations.execute,
            BACKOFFICE_PERMISSION.connections.read,
            BACKOFFICE_PERMISSION.upload.read,
          ]);
          const executed = await createIntegrationScenarioTerminal(
            ctx.runtime.services,
            delegated.execution,
            delegated.kernel,
          ).exec(`${command} --print structuredContent.echoed`);
          expect(executed.exitCode, executed.stderr).toBe(0);
          assert(executed.stdout === "delegated\n");
          expect(providers.calls).toEqual(["echo"]);

          // A resolved server does not retain authority revoked before its tool runs.
          const resolved = await createMcpIntegration({
            runtime: ctx.runtime.services,
            nowEpochMs: ctx.runtime.now,
          }).resolve({ kernel: delegated.kernel, execution: delegated.execution }, "shared");
          const echo = (await resolved.actions()).find((action) => action.definition.id === "echo");
          assert(echo);
          providers.delegatedGrants.splice(
            providers.delegatedGrants.indexOf(BACKOFFICE_PERMISSION.integrations.execute),
            1,
          );
          await expect(echo.invoke({ text: "revoked" })).rejects.toMatchObject({
            name: "BackofficeForbiddenError",
          });
          expect(providers.calls).toEqual(["echo"]);
        },
      ),
    ],
  }));
});
