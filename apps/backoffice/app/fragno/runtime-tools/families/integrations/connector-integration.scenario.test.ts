import { assert, expect, test, vi } from "vitest";

import { Buffer } from "node:buffer";

import { integrationSetupProgressSchema } from "@fragno-dev/backoffice-api/v0/integrations";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { readAutomationReplica } from "@/fragno/automation/lofi/testing";

import { ApiObject } from "../../../../../workers/api.do";
import { AppInstallationsObject } from "../../../../../workers/app-installations.do";
import { AppsObject } from "../../../../../workers/apps.do";
import { AuthObject } from "../../../../../workers/auth.do";
import { AutomationsObject } from "../../../../../workers/automations.do";
import { BillingObject } from "../../../../../workers/billing.do";
import { CodemodeObject } from "../../../../../workers/codemode.do";
import { FormsObject } from "../../../../../workers/forms.do";
import { GitHubWebhookRouterObject } from "../../../../../workers/github-webhook-router.do";
import { GitHubObject } from "../../../../../workers/github.do";
import { McpObject } from "../../../../../workers/mcp.do";
import { OtpObject } from "../../../../../workers/otp.do";
import { ProjectConnectorObject } from "../../../../../workers/project-connector.do";
import { ResendObject } from "../../../../../workers/resend.do";
import { TelegramObject } from "../../../../../workers/telegram.do";
import { UploadObject } from "../../../../../workers/upload.do";
import { runProjectConnectorScenario } from "../project-connector-scenario.test-utils";
import { encodeConnectorConnectionId } from "./connector-connection-id";

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
  RESEND: (input) => new ResendObject(input),
  TELEGRAM: (input) => new TelegramObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

const owner = { kind: "user", userId: "connector-owner" } as const;
const stranger = { kind: "user", userId: "connector-stranger" } as const;
// Discovery preassigns the service as the name for the gateway's only Gmail provider.
const target = encodeConnectorConnectionId(["named", "project-1", "gmail-provider", "gmail"]);
const workTarget = encodeConnectorConnectionId(["named", "project-1", "gmail-provider", "work"]);
// The removed account-ID form: a flags byte, then the account ID as a NUL-terminated JSON string.
const accountAddress = `connector#a_${Buffer.from([0, ...Buffer.from('"gmail-account"\0')]).toString("base64url")}`;

test("Connector setup resumes consent across restarts and binds the account only to its owner", async () => {
  await runProjectConnectorScenario<{ authorizationUrl: string }>((gateway) => ({
    objects: scenarioObjects,
    name: "Connector OAuth through the integrations facade",
    vars: () => ({ authorizationUrl: "" }),
    steps: ({ then, runner }) => [
      then.assert("discovery offers a named target and setup starts consent", async (ctx) => {
        const run = await ctx.runCodemode({
          scope: owner,
          code: `async () => {
            const services = await integrations.discover();
            const target = services.find((service) => service.id === "gmail").setupTargets[0].connectionId;
            return {
              target,
              checked: await integrations.setup({ kind: "check", connectionId: target }),
              started: await integrations.setup({ kind: "input", connectionId: target, input: { start: true } }),
            };
          }`,
        });
        const { checked, started } = run.result as { checked: unknown; started: unknown };
        expect(run.result).toMatchObject({ target, checked: { status: "needs-input" } });
        expect(checked).toMatchObject({ connectionId: target });
        const progress = integrationSetupProgressSchema.parse(started);
        assert(progress.status === "needs-authorization");
        ctx.vars.authorizationUrl = progress.authorizationUrl;
        expect(gateway.links).toHaveLength(1);
      }),
      runner.restartObject({ binding: "PROJECT_CONNECTOR", scope: owner }),
      then.assert("checks after a restart resume the saved request", async (ctx) => {
        const run = await ctx.runCodemode({
          scope: owner,
          code: `async () => await integrations.setup({ kind: "check", connectionId: ${JSON.stringify(target)} })`,
        });
        expect(run.result).toMatchObject({
          status: "needs-authorization",
          authorizationUrl: ctx.vars.authorizationUrl,
        });
        expect(gateway.links).toHaveLength(1);
      }),
      then.assert("a check after consent confirms the account and its actions", async (ctx) => {
        const requestId = new URL(ctx.vars.authorizationUrl).pathname.split("/").at(-1);
        assert(requestId);
        gateway.authorize(requestId, "gmail-account");
        const run = await ctx.runCodemode({
          scope: owner,
          code: `async () => {
            const connectionId = ${JSON.stringify(target)};
            return {
              checked: await integrations.setup({ kind: "check", connectionId }),
              listed: (await integrations.list({ cursor: null })).connections.map((connection) => connection.connectionId),
              actions: (await integrations.actions({ connectionId })).map((action) => action.id),
              searched: await integrations.execute({ connectionId, actionId: "gmail.search_threads", input: { query: "is:unread" } }),
            };
          }`,
        });
        expect(run.result).toMatchObject({
          checked: { status: "ready", connectionId: target },
          listed: [target],
          actions: ["gmail.search_threads"],
          searched: { query: "is:unread" },
        });
        expect(gateway.executions.map((execution) => execution.connectedAccountId)).toEqual([
          "gmail-account",
        ]);
      }),
      runner.drain(),
      then.automation.event({
        scope: owner,
        where: { source: "integrations", eventType: "connection.ready" },
        expected: { subject: { service: "gmail", connectionId: target } },
      }),
      then.assert("another user's same address selects their own empty source", async (ctx) => {
        const run = await ctx.runCodemode({
          scope: stranger,
          code: `async () => ({
            listed: (await integrations.list({ cursor: null })).connections,
            inspected: await integrations.get({ connectionId: ${JSON.stringify(target)} }),
          })`,
        });
        expect(run.result).toMatchObject({
          listed: [],
          inspected: { configuration: { status: "missing" } },
        });
        expect(gateway.executions).toHaveLength(1);
      }),
      then.assert("account-ID addresses are no longer valid", async (ctx) => {
        const run = await ctx.runCodemode({
          scope: owner,
          code: `async () => {
            try {
              return await integrations.get({ connectionId: ${JSON.stringify(accountAddress)} });
            } catch (error) {
              return { error: error.message };
            }
          }`,
        });
        expect(run.result).toEqual({ error: "Connector integration connection ID is invalid." });
      }),
      then.assert("an account under another name starts its own consent", async (ctx) => {
        const run = await ctx.runCodemode({
          scope: owner,
          code: `async () => await integrations.setup({ kind: "input", connectionId: ${JSON.stringify(workTarget)}, input: { start: true } })`,
        });
        const progress = integrationSetupProgressSchema.parse(run.result);
        assert(progress.status === "needs-authorization");
        const requestId = new URL(progress.authorizationUrl).pathname.split("/").at(-1);
        assert(requestId);
        gateway.authorize(requestId, "work-account");
        const checked = await ctx.runCodemode({
          scope: owner,
          code: `async () => await integrations.setup({ kind: "check", connectionId: ${JSON.stringify(workTarget)} })`,
        });
        expect(checked.result).toMatchObject({ status: "ready" });
      }),
      runner.drain(),
      then.assert(
        "the overview titles accounts by service, adding names other than the default",
        async (ctx) => {
          const replica = ctx.lofi.automations.forScope(owner);
          await replica.drain();
          const connections = (
            await readAutomationReplica(replica.replica, "integrationConnections", undefined)
          ).sort((left, right) => left.displayName.localeCompare(right.displayName));
          expect(
            connections.map(({ connectionId, displayName, kindLabel }) => ({
              connectionId,
              displayName,
              kindLabel,
            })),
          ).toEqual([
            { connectionId: target, displayName: "gmail", kindLabel: "Connector · gmail" },
            {
              connectionId: workTarget,
              displayName: "gmail · work",
              kindLabel: "Connector · gmail",
            },
          ]);
        },
      ),
    ],
  }));
});
