import { assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";

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
import { InMemoryUploadObject } from "../../../../../workers/upload.do";

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
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const scope = { kind: "org", orgId: "telegram-org" } as const;
const connectionId = "backoffice#telegram";
const botToken = "123456:integration-bot-token";

test("Telegram connects, acts, checks its webhook, and disconnects through integrations", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Telegram bot lifecycle through the integrations facade",
      fakes: ({ fake }) => ({
        telegram: fake.telegram({
          files: [
            {
              fileId: "voice-1",
              fileUniqueId: "voice-unique-1",
              filePath: "voice/file.ogg",
              fileSize: 3,
              bytes: new Uint8Array([1, 2, 3]),
              contentType: "audio/ogg",
            },
          ],
        }),
      }),
      setup: ({ given }) => [given.organization.exists({ id: scope.orgId, name: "Telegram" })],
      steps: ({ then, runner }) => [
        then.assert(
          "setup registers the bot's webhook without returning the token",
          async (ctx) => {
            const run = await ctx.runCodemode({
              scope,
              code: `async () => {
              const target = { connectionId: "backoffice#telegram" };
              const before = await integrations.setup({ ...target, kind: "check" });
              const ready = await integrations.setup({ ...target, kind: "input", input: { botToken: ${JSON.stringify(botToken)}, botUsername: null } });
              return { before, ready, page: await integrations.list({ cursor: null }), verified: await integrations.verify(target) };
            }`,
              assertToolCalls: ["integrations.setup", "integrations.list", "integrations.verify"],
            });
            expect(run.result).toMatchObject({
              before: { status: "needs-input", connectionId, secretFields: ["botToken"] },
              ready: { status: "ready", connectionId },
              page: {
                connections: [
                  {
                    connectionId,
                    integrationId: "telegram",
                    configuration: { status: "configured" },
                  },
                ],
                cursor: null,
              },
              verified: { checks: [{ id: "webhook.read", status: "passed" }], nextSteps: [] },
            });
            expect(JSON.stringify(run.result)).not.toContain(botToken);
            expect(ctx.fakes.telegram?.setWebhookCalls).toEqual([
              expect.objectContaining({
                botToken,
                webhookUrl: expect.stringContaining(
                  "/api/telegram/org:telegram-org/telegram/webhook",
                ),
                // Setup generates the secret Telegram echoes on each delivery.
                secretToken: expect.stringMatching(/^tg_[a-f0-9]{32}$/),
              }),
            ]);
          },
        ),
        then.assert("actions reach the bot and its received files", async (ctx) => {
          const run = await ctx.runCodemode({
            scope,
            code: `async () => {
              const connectionId = "backoffice#telegram";
              const execute = (actionId, input) => integrations.execute({ connectionId, actionId, input });
              return {
                actions: (await integrations.actions({ connectionId })).map((action) => action.id),
                sent: await execute("messages.send", { chatId: "1001", text: "Hello from integrations", parseMode: null, disableWebPagePreview: false, replyToMessageId: null }),
                typing: await execute("chat-actions.send", { chatId: "1001", action: "typing" }),
                file: await execute("files.get", { fileId: "voice-1" }),
                download: await execute("files.download", { fileId: "voice-1" }),
              };
            }`,
          });
          expect(run.result).toEqual({
            actions: [
              "messages.send",
              "messages.edit",
              "chat-actions.send",
              "files.get",
              "files.download",
            ],
            sent: { ok: true, queued: true },
            typing: { ok: true },
            file: {
              fileId: "voice-1",
              fileUniqueId: "voice-unique-1",
              filePath: "voice/file.ogg",
              fileSize: 3,
            },
            download: { bytes: [1, 2, 3], contentType: "audio/ogg" },
          });
        }),
        runner.drain(),
        then.telegram.sentMessage({ chatId: "1001", text: "Hello from integrations" }),
        then.telegram.sentChatAction({ chatId: "1001", action: "typing" }),
        then.automation.event({
          scope,
          where: { source: "integrations", eventType: "connection.ready" },
          expected: { subject: { service: "telegram", connectionId } },
        }),
        then.assert(
          "a rejected webhook blocks reconfiguration and fails verification",
          async (ctx) => {
            const telegram = ctx.fakes.telegram;
            assert(telegram);
            telegram.webhook.rejection = "Bad Request: an HTTPS URL must be provided for webhook";
            telegram.webhook.registeredUrl = null;
            const run = await ctx.runCodemode({
              scope,
              code: `async () => {
                const target = { connectionId: "backoffice#telegram" };
                const reconfigured = await integrations.reconfigure({ ...target, kind: "input", input: { botToken: "654321:replacement-token", botUsername: "fragno_bot" } });
                return { reconfigured, verified: await integrations.verify(target) };
              }`,
              assertToolCalls: ["integrations.reconfigure", "integrations.verify"],
            });
            expect(run.result).toMatchObject({
              reconfigured: {
                status: "blocked",
                reason: expect.stringContaining("an HTTPS URL must be provided"),
              },
              verified: {
                checks: [{ status: "failed", message: expect.stringContaining("no webhook") }],
                nextSteps: [expect.stringContaining("Reconfigure")],
              },
            });
          },
        ),
        then.assert(
          "disconnecting removes the bot but keeps the address for setup",
          async (ctx) => {
            const run = await ctx.runCodemode({
              scope,
              code: `async () => {
                const target = { connectionId: "backoffice#telegram" };
                const disconnected = await integrations.disconnect({ ...target, confirm: target.connectionId });
                const repeated = await integrations.disconnect({ ...target, confirm: target.connectionId });
                const page = await integrations.list({ cursor: null });
                const setup = await integrations.setup({ ...target, kind: "check" });
                try { await integrations.execute({ ...target, actionId: "chat-actions.send", input: { chatId: "1001", action: "typing" } }); }
                catch (error) { return { disconnected, repeated, page, setup, executionError: error.message }; }
                throw new Error("Unconfigured Telegram unexpectedly sent a chat action");
              }`,
            });
            expect(run.result).toMatchObject({
              disconnected: { connectionId, status: "disconnected" },
              repeated: { connectionId, status: "not-configured" },
              page: { connections: [], cursor: null },
              setup: { status: "needs-input", connectionId },
              executionError: expect.stringContaining("not configured"),
            });
          },
        ),
        runner.drain(),
        then.automation.event({
          scope,
          where: { source: "integrations", eventType: "connection.disconnected" },
          expected: { subject: { service: "telegram", connectionId } },
        }),
        then.assert("the same address in system scope sets up the system bot", async (ctx) => {
          const telegram = ctx.fakes.telegram;
          assert(telegram);
          telegram.webhook.rejection = null;
          const run = await ctx.runCodemode({
            scope: { kind: "system" },
            code: `async () => await integrations.setup({ connectionId: "backoffice#telegram", kind: "input", input: { botToken: "777:system-bot-token", botUsername: null } })`,
          });
          expect(run.result).toEqual({ status: "ready", connectionId });
          expect(telegram.setWebhookCalls.at(-1)).toMatchObject({
            botToken: "777:system-bot-token",
            webhookUrl: expect.stringContaining("/api/telegram/system/telegram/webhook"),
          });
        }),
        runner.drain(),
        then.automation.event({
          scope: { kind: "system" },
          where: { source: "integrations", eventType: "connection.ready" },
          expected: { subject: { service: "telegram", connectionId } },
        }),
      ],
    }),
  );
});

test("a personal bot removed before its setup report dispatches still reports both changes", async () => {
  const userScope = { kind: "user", userId: "user-1" } as const;
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Telegram slot reports survive a reset",
      fakes: ({ fake }) => ({ telegram: fake.telegram() }),
      setup: ({ given }) => [given.auth.user({ id: "user-1", email: "user@example.test" })],
      steps: ({ then, runner }) => [
        then.assert("setup and disconnect run back to back", async (ctx) => {
          const run = await ctx.runCodemode({
            scope: userScope,
            code: `async () => {
              const target = { connectionId: "backoffice#telegram" };
              const ready = await integrations.setup({ ...target, kind: "input", input: { botToken: "555:user-bot-token", botUsername: null } });
              const disconnected = await integrations.disconnect({ ...target, confirm: target.connectionId });
              return { ready, disconnected };
            }`,
          });
          expect(run.result).toMatchObject({
            ready: { status: "ready", connectionId },
            disconnected: { status: "disconnected", connectionId },
          });
        }),
        runner.drain(),
        then.automation.event({
          scope: userScope,
          where: { source: "integrations", eventType: "connection.ready" },
          expected: { subject: { service: "telegram", connectionId } },
        }),
        then.automation.event({
          scope: userScope,
          where: { source: "integrations", eventType: "connection.disconnected" },
          expected: { subject: { service: "telegram", connectionId } },
        }),
      ],
    }),
  );
});
