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
import { runProjectConnectorScenario } from "../project-connector-scenario.test-utils";
import { encodeConnectorConnectionId } from "./connector-connection-id";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  APPS: (input) => new InMemoryAppsObject(input),
  APP_INSTALLATIONS: (input) => new InMemoryAppInstallationsObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  CODEMODE: (input) => new InMemoryCodemodeObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  GITHUB: (input) => new InMemoryGitHubObject(input),
  GITHUB_WEBHOOK_ROUTER: (input) => new InMemoryGitHubWebhookRouterObject(input),
  MCP: (input) => new InMemoryMcpObject(input),
  OTP: (input) => new InMemoryOtpObject(input),
  PROJECT_CONNECTOR: (input) => new InMemoryProjectConnectorObject(input),
  RESEND: (input) => new InMemoryResendObject(input),
  RESON8: (input) => new InMemoryReson8Object(input),
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const owner = { kind: "user", userId: "connector-owner" } as const;
const stranger = { kind: "user", userId: "connector-stranger" } as const;
// Discovery offers the preassigned `backoffice` name for the gateway's only Gmail provider.
const target = encodeConnectorConnectionId(["named", "project-1", "gmail-provider", "backoffice"]);
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
    ],
  }));
});
