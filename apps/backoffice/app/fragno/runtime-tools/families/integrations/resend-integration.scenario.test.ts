import { expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";

import { ApiObject } from "../../../../../workers/api-object";
import { AppInstallationsObject } from "../../../../../workers/app-installations-object";
import { AppsObject } from "../../../../../workers/apps-object";
import { AuthObject } from "../../../../../workers/auth-object";
import { AutomationsObject } from "../../../../../workers/automations-object";
import { BillingObject } from "../../../../../workers/billing-object";
import { CodemodeObject } from "../../../../../workers/codemode-object";
import { FormsObject } from "../../../../../workers/forms-object";
import { GitHubObject } from "../../../../../workers/github-object";
import { GitHubWebhookRouterObject } from "../../../../../workers/github-webhook-router-object";
import { McpObject } from "../../../../../workers/mcp-object";
import { OtpObject } from "../../../../../workers/otp-object";
import { ProjectConnectorObject } from "../../../../../workers/project-connector-object";
import { ResendObject } from "../../../../../workers/resend-object";
import { TelegramObject } from "../../../../../workers/telegram-object";
import { UploadObject } from "../../../../../workers/upload-object";

const scenarioObjects = {
  API: (input) => new ApiObject(input),
  APPS: (input) => new AppsObject(input),
  APP_INSTALLATIONS: (input) => new AppInstallationsObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  BILLING: (input) => new BillingObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  FORMS: (input) => new FormsObject(input),
  GITHUB: (input) => new GitHubObject(input),
  GITHUB_WEBHOOK_ROUTER: (input) => new GitHubWebhookRouterObject(input),
  MCP: (input) => new McpObject(input),
  OTP: (input) => new OtpObject(input),
  PROJECT_CONNECTOR: (input) => new ProjectConnectorObject(input),
  TELEGRAM: (input) => new TelegramObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

const scope = { kind: "org", orgId: "resend-org", jurisdiction: null } as const;
const connectionId = "backoffice#resend";
const apiKey = "re_integration_key";
const webhookUrl = "https://example.com/api/resend/org:resend-org/webhook";

/** Resend's webhook API as one account sees it; a rejection fails every registration. */
function createResendWebhookProvider() {
  const provider = {
    endpoint: null as string | null,
    rejection: null as string | null,
    registrations: [] as { apiKey: string; endpoint: string }[],
  };
  function register(key: string, endpoint: string) {
    if (provider.rejection !== null) {
      return { data: null, error: { message: provider.rejection } };
    }
    provider.registrations.push({ apiKey: key, endpoint });
    provider.endpoint = endpoint;
    return { data: { id: "webhook-1", signing_secret: "whsec_c2VjcmV0" }, error: null };
  }
  function createClient(key: string) {
    return {
      webhooks: {
        create: async ({ endpoint }: { endpoint: string }) => register(key, endpoint),
        update: async (_id: string, { endpoint }: { endpoint: string }) => register(key, endpoint),
        get: async () =>
          provider.endpoint === null
            ? { data: null, error: { message: "Webhook not found" } }
            : { data: { endpoint: provider.endpoint, status: "enabled" }, error: null },
      },
    } as never;
  }
  return { provider, createClient };
}

test("Resend connects, checks its webhook, rejects bad values, and disconnects through integrations", async () => {
  const { provider, createClient } = createResendWebhookProvider();
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: {
        ...scenarioObjects,
        RESEND: (options) => new ResendObject({ ...options, createClient }),
      },
      name: "Resend lifecycle through the integrations facade",
      setup: ({ given }) => [given.organization.exists({ id: scope.orgId, name: "Resend" })],
      steps: ({ then, runner }) => [
        then.assert(
          "setup registers this deployment's webhook without returning the key",
          async (ctx) => {
            const run = await ctx.runCodemode({
              scope,
              code: `async () => {
                const target = { connectionId: "backoffice#resend" };
                const before = await integrations.setup({ ...target, kind: "check" });
                const ready = await integrations.setup({ ...target, kind: "input", input: { apiKey: ${JSON.stringify(apiKey)}, defaultFrom: "Support <support@example.com>", defaultReplyTo: [] } });
                return { before, ready, page: await integrations.list({ cursor: null }), verified: await integrations.verify(target) };
              }`,
              assertToolCalls: ["integrations.setup", "integrations.list", "integrations.verify"],
            });
            expect(run.result).toMatchObject({
              before: { status: "needs-input", connectionId, secretFields: ["apiKey"] },
              ready: { status: "ready", connectionId },
              page: {
                connections: [
                  {
                    connectionId,
                    integrationId: "resend",
                    configuration: { status: "configured" },
                  },
                ],
                cursor: null,
              },
              verified: { checks: [{ id: "webhook.read", status: "passed" }], nextSteps: [] },
            });
            expect(JSON.stringify(run.result)).not.toContain(apiKey);
            expect(provider.registrations).toEqual([{ apiKey, endpoint: webhookUrl }]);
          },
        ),
        runner.drain(),
        then.automation.event({
          scope,
          where: { source: "integrations", eventType: "connection.ready" },
          expected: { subject: { service: "resend", connectionId } },
        }),
        then.assert(
          "a rejected reconfiguration keeps the stored values, and a lost webhook fails verification",
          async (ctx) => {
            provider.rejection = "API key is invalid";
            const rejected = await ctx.runCodemode({
              scope,
              code: `async () => await integrations.reconfigure({ connectionId: "backoffice#resend", kind: "input", input: { apiKey: "re_wrong", defaultFrom: "Support <support@example.com>", defaultReplyTo: [] } })`,
            });
            expect(rejected.result).toMatchObject({
              status: "needs-input",
              instructions: expect.stringContaining("API key is invalid"),
            });
            expect(
              await ctx.runtime.objects.resend
                .for({ kind: "org", orgId: scope.orgId, jurisdiction: null })
                .commands.getAdminConfig(),
            ).toMatchObject({ configured: true, config: { apiKeyPreview: "re_i…_key" } });
            provider.endpoint = null;
            const verified = await ctx.runCodemode({
              scope,
              code: `async () => await integrations.verify({ connectionId: "backoffice#resend" })`,
            });
            expect(verified.result).toMatchObject({
              checks: [{ status: "failed", message: "Webhook not found" }],
              nextSteps: [expect.stringContaining("Reconfigure")],
            });
          },
        ),
        then.assert("disconnecting keeps the address for setup", async (ctx) => {
          const run = await ctx.runCodemode({
            scope,
            code: `async () => {
              const target = { connectionId: "backoffice#resend" };
              const disconnected = await integrations.disconnect({ ...target, confirm: target.connectionId });
              const repeated = await integrations.disconnect({ ...target, confirm: target.connectionId });
              return { disconnected, repeated, page: await integrations.list({ cursor: null }), setup: await integrations.setup({ ...target, kind: "check" }) };
            }`,
          });
          expect(run.result).toMatchObject({
            disconnected: { connectionId, status: "disconnected" },
            repeated: { connectionId, status: "not-configured" },
            page: { connections: [], cursor: null },
            setup: { status: "needs-input", connectionId },
          });
        }),
        runner.drain(),
        then.automation.event({
          scope,
          where: { source: "integrations", eventType: "connection.disconnected" },
          expected: { subject: { service: "resend", connectionId } },
        }),
        then.assert(
          "the same address in system scope sets up the platform account",
          async (ctx) => {
            provider.rejection = null;
            const run = await ctx.runCodemode({
              scope: { kind: "system" },
              code: `async () => {
                const target = { connectionId: "backoffice#resend" };
                const ready = await integrations.setup({ ...target, kind: "input", input: { apiKey: "re_platform_key", defaultFrom: "Backoffice <noreply@example.com>", defaultReplyTo: [] } });
                return { ready, verified: await integrations.verify(target) };
              }`,
            });
            expect(run.result).toMatchObject({
              ready: { status: "ready", connectionId },
              verified: { checks: [{ status: "passed" }] },
            });
            expect(provider.registrations.at(-1)).toEqual({
              apiKey: "re_platform_key",
              endpoint: "https://example.com/api/resend/system/webhook",
            });
            expect(
              await ctx.runtime.objects.resend
                .for({ kind: "org", orgId: scope.orgId, jurisdiction: null })
                .commands.getAdminConfig(),
            ).toEqual({ configured: false });
          },
        ),
        runner.drain(),
        then.automation.event({
          scope: { kind: "system" },
          where: { source: "integrations", eventType: "connection.ready" },
          expected: { subject: { service: "resend", connectionId } },
        }),
      ],
    }),
  );
});

test("Resend thread actions list, read, and reply to email threads", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Resend thread actions through the integrations facade",
      fakes: ({ fake }) => ({
        resend: fake.resend({
          threads: [
            {
              id: "thread-1",
              subject: "Order question",
              messages: [
                {
                  id: "message-1",
                  direction: "inbound",
                  from: "customer@example.com",
                  text: "Where is my order?",
                },
              ],
            },
          ],
        }),
      }),
      setup: ({ given }) => [given.organization.exists({ id: scope.orgId, name: "Resend" })],
      steps: ({ then }) => [
        then.assert("actions read threads and reply to the latest sender", async (ctx) => {
          const run = await ctx.runCodemode({
            scope,
            code: `async () => {
              const connectionId = "backoffice#resend";
              const execute = (actionId, input) => integrations.execute({ connectionId, actionId, input });
              return {
                actions: (await integrations.actions({ connectionId })).map((action) => action.id),
                page: await execute("threads.list", { cursor: null, pageSize: null, order: null }),
                thread: await execute("threads.get", { threadId: "thread-1", cursor: null, pageSize: 10, order: "desc" }),
                reply: await execute("threads.reply", { threadId: "thread-1", subject: null, body: "It ships today." }),
              };
            }`,
          });
          expect(run.result).toMatchObject({
            actions: ["threads.list", "threads.get", "threads.reply"],
            page: { threads: [{ id: "thread-1" }], cursor: null, hasNextPage: false },
            thread: {
              thread: { id: "thread-1", subject: "Order question" },
              messages: [{ id: "message-1", text: "Where is my order?" }],
              cursor: null,
              markdown: expect.stringContaining("Where is my order?"),
            },
            reply: { message: { direction: "outbound", text: "It ships today." } },
          });
        }),
        then.resend.repliedToThread({ threadId: "thread-1", body: "It ships today." }),
      ],
    }),
  );
});
