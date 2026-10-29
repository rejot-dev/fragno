import { assert, expect, test, vi } from "vitest";

import { Buffer } from "node:buffer";

import { integrationSetupProgressSchema } from "@fragno-dev/backoffice-api/v0/integrations";
import type { z } from "zod";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { readAutomationReplica } from "@/fragno/automation/lofi/testing";

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

const owner = { kind: "user", userId: "connector-owner", jurisdiction: null } as const;
const stranger = { kind: "user", userId: "connector-stranger", jurisdiction: null } as const;
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

test("Connector setup replaces an ended attempt, offers started names, and starts other names", async () => {
  await runProjectConnectorScenario<{ requestIds: string[] }>((gateway) => ({
    objects: scenarioObjects,
    name: "Connector attempts are replaced under their own name",
    vars: () => ({ requestIds: [] }),
    steps: ({ then }) => {
      /** Runs one integrations call as the owner; the gateway's links end in the request ID. */
      async function setup(
        ctx: Parameters<Parameters<typeof then.assert>[1]>[0],
        call: string,
      ): Promise<z.output<typeof integrationSetupProgressSchema>> {
        const run = await ctx.runCodemode({ scope: owner, code: `async () => await ${call}` });
        const progress = integrationSetupProgressSchema.parse(run.result);
        if (progress.status === "needs-authorization") {
          const requestId = new URL(progress.authorizationUrl).pathname.split("/").at(-1);
          assert(requestId);
          ctx.vars.requestIds.push(requestId);
        }
        return progress;
      }
      const check = (connectionId: string, operation = "setup") =>
        `integrations.${operation}({ kind: "check", connectionId: ${JSON.stringify(connectionId)} })`;
      const start = (
        connectionId: string,
        input: { start: true; connectionName?: string } = { start: true },
        operation = "setup",
      ) =>
        `integrations.${operation}({ kind: "input", connectionId: ${JSON.stringify(connectionId)}, input: ${JSON.stringify(input)} })`;
      return [
        then.assert("a failed attempt asks for a start that replaces it", async (ctx) => {
          expect(await setup(ctx, start(target))).toMatchObject({ status: "needs-authorization" });
          const failed = gateway.requests.get(ctx.vars.requestIds[0]!);
          assert(failed);
          failed.status = "failed";
          failed.errorCode = "authorization_failed";
          failed.errorMessage = "Consent was rejected";
          const checked = await setup(ctx, check(target));
          assert(checked.status === "needs-input");
          expect(checked.instructions).toContain(
            "The last OAuth attempt failed (authorization_failed): Consent was rejected.",
          );
          const restarted = await setup(ctx, start(target));
          expect(restarted).toMatchObject({ status: "needs-authorization", connectionId: target });
          expect(ctx.vars.requestIds).toHaveLength(2);
          expect(gateway.links).toHaveLength(2);
        }),
        then.assert("an attempt the gateway purged asks for a start too", async (ctx) => {
          gateway.requests.delete(ctx.vars.requestIds[1]!);
          const checked = await setup(ctx, check(target));
          assert(checked.status === "needs-input");
          expect(checked.instructions).toContain(
            "The last OAuth attempt expired before consent completed.",
          );
          const restarted = await setup(ctx, start(target));
          expect(restarted).toMatchObject({ status: "needs-authorization", connectionId: target });
          expect(ctx.vars.requestIds).toHaveLength(3);
          expect(gateway.links).toHaveLength(3);
          // Later steps follow the live replacement, not the purged attempt.
          ctx.vars.requestIds.splice(1, 1);
        }),
        then.assert("only the replacement's consent binds the name", async (ctx) => {
          const [first, replacement] = ctx.vars.requestIds;
          assert(first && replacement);
          gateway.authorize(first, "stale-account");
          gateway.authorize(replacement, "gmail-account");
          expect(await setup(ctx, check(target))).toEqual({
            connectionId: target,
            status: "ready",
          });
          const run = await ctx.runCodemode({
            scope: owner,
            code: `async () => await integrations.execute({ connectionId: ${JSON.stringify(target)}, actionId: "gmail.search_threads", input: { query: "is:unread" } })`,
          });
          expect(run.result).toMatchObject({ query: "is:unread" });
          expect(gateway.executions.map((execution) => execution.connectedAccountId)).toEqual([
            "gmail-account",
          ]);
        }),
        then.assert("setup input starts another name, which discovery then offers", async (ctx) => {
          expect(
            await setup(ctx, start(target, { start: true, connectionName: "work" })),
          ).toMatchObject({ status: "needs-authorization", connectionId: workTarget });
          const run = await ctx.runCodemode({
            scope: owner,
            code: `async () => (await integrations.discover()).find((service) => service.id === "gmail").setupTargets`,
          });
          expect(run.result).toEqual([
            { kind: "connection", connectionId: target },
            { kind: "connection", connectionId: workTarget },
          ]);
          // Repeating the start reuses the pending link instead of abandoning it.
          const repeated = await setup(ctx, start(workTarget));
          assert(repeated.status === "needs-authorization");
          expect(new Set(ctx.vars.requestIds.slice(2))).toHaveProperty("size", 1);
        }),
        then.assert(
          "invalid input selects no connection, not even a pending or ready one",
          async (ctx) => {
            const links = gateway.links.length;
            // `target` is ready and `workTarget` is pending; neither may answer for invalid input.
            for (const connectionId of [target, workTarget]) {
              for (const operation of ["setup", "reconfigure"]) {
                await expect(
                  ctx.runCodemode({
                    scope: owner,
                    code: `async () => await ${start(connectionId, { start: true, connectionName: "Work" }, operation)}`,
                  }),
                ).rejects.toThrow();
              }
            }
            expect(gateway.links).toHaveLength(links);
          },
        ),
        then.assert("reconfigure consents again while the account stays usable", async (ctx) => {
          const checked = await setup(ctx, check(target, "reconfigure"));
          assert(checked.status === "needs-input");
          expect(checked.instructions).toContain("The current account stays usable");
          expect(await setup(ctx, start(target, { start: true }, "reconfigure"))).toMatchObject({
            status: "needs-authorization",
            connectionId: target,
          });
          // Setup reports the pending replacement until its consent confirms.
          expect(await setup(ctx, check(target))).toMatchObject({ status: "needs-authorization" });
          gateway.authorize(ctx.vars.requestIds.at(-1)!, "replacement-account");
          expect(await setup(ctx, check(target))).toEqual({
            connectionId: target,
            status: "ready",
          });
          await ctx.runCodemode({
            scope: owner,
            code: `async () => await integrations.execute({ connectionId: ${JSON.stringify(target)}, actionId: "gmail.search_threads", input: { query: "is:read" } })`,
          });
          expect(gateway.executions.map((execution) => execution.connectedAccountId)).toEqual([
            "gmail-account",
            "replacement-account",
          ]);
        }),
      ];
    },
  }));
});
