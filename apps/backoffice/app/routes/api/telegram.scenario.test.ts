import { assert, describe, expect, test, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { z } from "zod";

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BACKOFFICE_INTERNAL_CONTEXT_HEADER } from "@/backoffice-runtime/internal-object-request";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { telegramAutomationFileDownloadPath } from "@/backoffice-runtime/telegram-file-response";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
  type BackofficeScenarioDefinitionInput,
} from "@/fragno/automation/scenario";
import { setScenarioAuthUserRole } from "@/fragno/automation/scenario-auth";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { InMemoryApiObject } from "../../../workers/api.do";
import { InMemoryAuthObject } from "../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../workers/automations.do";
import { InMemoryFormsObject } from "../../../workers/forms.do";
import { InMemoryOtpObject } from "../../../workers/otp.do";
import { InMemoryUploadObject } from "../../../workers/upload.do";
import { action, loader } from "./telegram";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  OTP: (input) => new InMemoryOtpObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const orgId = "telegram-org";
const webhookSecret = "telegram-webhook-secret";
const scopePath = "org%3Atelegram-org";

async function runTelegramScenario(scenario: BackofficeScenarioDefinitionInput) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-telegram-security-"));
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        ...scenario,
        options: { ...scenario.options, sqliteDataDirectory: directory },
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function callPublicTelegram(
  ctx: BackofficeScenarioContext,
  input: {
    scopePath: string;
    suffix: string;
    method: string;
    headers: HeadersInit;
    body: unknown;
  },
) {
  const url = new URL(
    `/api/telegram/${input.scopePath}${input.suffix}`,
    "https://backoffice.example",
  );
  const headers = new Headers(input.headers);
  if (input.method !== "GET" && input.method !== "HEAD") {
    headers.set("content-type", "application/json");
    headers.set("origin", url.origin);
  }
  const request = new Request(url, {
    method: input.method,
    headers,
    ...(input.method === "GET" || input.method === "HEAD"
      ? {}
      : { body: JSON.stringify(input.body) }),
  });
  const args = {
    request,
    url,
    pattern: "/api/telegram/:scopeSegment/*",
    context: createBackofficeRouterContextProvider(request, {
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      env: ctx.runtime.env as unknown as CloudflareEnv,
      ctx: {} as ExecutionContext,
    }),
    params: { scopeSegment: decodeURIComponent(input.scopePath), "*": input.suffix.slice(1) },
  };
  return input.method === "GET" || input.method === "HEAD"
    ? await loader(args)
    : await action(args);
}

async function authenticateTelegramUser(ctx: BackofficeScenarioContext, role: "user" | "admin") {
  const auth = ctx.runtime.objects.auth.singleton();
  const sessionCookie = ctx.vars.session;
  assert(typeof sessionCookie === "string");
  const session = await auth.http.fetch(
    new Request("https://backoffice.example/api/auth/get-session", {
      headers: { cookie: sessionCookie },
    }),
  );
  assert(session.ok);
  const userId = z.object({ user: z.object({ id: z.string() }) }).parse(await session.json())
    .user.id;
  await auth.commands.applyScenarioFixture({
    members: [{ organizationId: orgId, userId, roles: ["member"] }],
  });
  if (role === "admin") {
    await setScenarioAuthUserRole(ctx.runtime, { userId, role });
  }
  const exchange = await auth.http.fetch(
    new Request("https://backoffice.example/api/auth/backoffice-token", {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: "https://backoffice.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ selection: "preferred", organizationId: orgId }),
    }),
  );
  assert(exchange.ok, await exchange.clone().text());
  const cookie = exchange.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  assert(cookie);
  return { userId, cookie };
}

function webhookUpdate(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_767_225_600,
      chat: { id: 1234, type: "private" },
      from: { id: 5678, is_bot: false, first_name: "Ada" },
      text,
    },
  };
}

async function readPersistedTelegramMessages(ctx: BackofficeScenarioContext) {
  return await ctx.runtime.objects.telegram
    .forOrg(orgId)
    .http.fetchAuthorized(new Request("https://telegram.do/api/telegram/chats/1234/messages"), {
      execution: createBackofficeSystemExecution({ kind: "org", orgId }),
      propagationContext: null,
    });
}

async function assertNoTelegramDeliveries(ctx: BackofficeScenarioContext) {
  assert(ctx.fakes.telegram);
  await ctx.runtime.drain();
  expect(ctx.fakes.telegram.sendMessageCalls).toEqual([]);
  expect(ctx.fakes.telegram.editMessageTextCalls).toEqual([]);
  expect(ctx.fakes.telegram.sendChatActionCalls).toEqual([]);
  const queue = await ctx.runtime.objects.telegram.forOrg(orgId).commands.getDurableHookQueue();
  expect(queue.items.filter((hook) => hook.hookName === "internalOutgoingMessage")).toEqual([]);
}

describe("Telegram public authorization scenarios", () => {
  test("anonymous callers cannot read private conversations or execute management operations", async () => {
    await runTelegramScenario({
      objects: scenarioObjects,
      name: "Telegram webhook secrets do not authorize management APIs",
      fakes: ({ fake }) => ({ telegram: fake.telegram() }),
      setup: ({ given }) => [
        given.organization.exists({ id: orgId, slug: "different-public-slug" }),
        given.telegram.configured({ orgId, botUsername: "fragno_bot" }),
      ],
      steps: ({ when, then }) => [
        when.telegram.receivesMessage({
          orgId,
          updateId: 1,
          chatId: "1234",
          text: "private message",
        }),
        then.assert("all management requests require Backoffice authentication", async (ctx) => {
          for (const input of [
            { method: "GET", suffix: "/chats", body: null },
            { method: "GET", suffix: "/chats/1234", body: null },
            { method: "GET", suffix: "/chats/1234/messages", body: null },
            { method: "GET", suffix: "/commands?chatId=1234", body: null },
            { method: "POST", suffix: "/chats/1234/send", body: { text: "unauthorized send" } },
            { method: "POST", suffix: "/chats/1234/actions", body: { action: "typing" } },
            {
              method: "POST",
              suffix: "/chats/1234/messages/1/edit",
              body: { text: "unauthorized edit" },
            },
            {
              method: "POST",
              suffix: "/commands/bind",
              body: { chatId: "1234", commandName: "start", enabled: false },
            },
          ]) {
            const response = await callPublicTelegram(ctx, {
              ...input,
              scopePath,
              headers: {
                "x-telegram-bot-api-secret-token": webhookSecret,
                "x-user-id": "user-1",
                "x-user-role": "admin",
                [BACKOFFICE_INTERNAL_CONTEXT_HEADER]: "forged-internal-authority",
              },
            });
            assert.equal(response.status, 401);
            assert(!(await response.text()).includes("private message"));
          }
          await assertNoTelegramDeliveries(ctx);
          const persisted = await readPersistedTelegramMessages(ctx);
          assert(persisted.ok);
          expect(await persisted.json()).toMatchObject({ messages: [{ text: "private message" }] });
        }),
      ],
    });
  });

  test("only the exact POST webhook accepts anonymous requests and still validates its secret", async () => {
    await runTelegramScenario({
      objects: scenarioObjects,
      name: "Telegram public webhook anonymity is method and path bound",
      fakes: ({ fake }) => ({ telegram: fake.telegram() }),
      setup: ({ given }) => [
        given.organization.exists({ id: orgId }),
        given.telegram.configured({ orgId, botUsername: "fragno_bot" }),
      ],
      steps: ({ then }) => [
        then.assert(
          "invalid secrets and webhook-like paths cannot deliver updates",
          async (ctx) => {
            for (const secret of ["", "wrong-secret"]) {
              const response = await callPublicTelegram(ctx, {
                scopePath,
                suffix: "/telegram/webhook",
                method: "POST",
                headers: { "x-telegram-bot-api-secret-token": secret },
                body: webhookUpdate(100, "rejected update"),
              });
              assert.equal(response.status, 401);
            }
            for (const input of [
              { method: "GET", suffix: "/telegram/webhook" },
              { method: "PUT", suffix: "/telegram/webhook" },
              { method: "POST", suffix: "/telegram/webhook/" },
              { method: "POST", suffix: "/telegram/webhook/chats/1234/send" },
              { method: "POST", suffix: "/telegram/webhook%2Fchats%2F1234%2Fsend" },
              { method: "POST", suffix: "/telegram/webhook/../../chats/1234/send" },
            ]) {
              const response = await callPublicTelegram(ctx, {
                ...input,
                scopePath,
                headers: { "x-telegram-bot-api-secret-token": webhookSecret },
                body: { text: "unauthorized send" },
              });
              assert.equal(response.status, 401);
            }
            for (const [index, publicScopePath] of [scopePath, "org:telegram-org"].entries()) {
              const response = await callPublicTelegram(ctx, {
                scopePath: publicScopePath,
                suffix: "/telegram/webhook?scope=org%3Aattacker-org",
                method: "POST",
                headers: {
                  "x-telegram-bot-api-secret-token": webhookSecret,
                  authorization: "Bearer invalid-backoffice-token",
                  [BACKOFFICE_INTERNAL_CONTEXT_HEADER]: "forged-internal-authority",
                },
                body: webhookUpdate(200 + index, "verified update"),
              });
              assert.equal(response.status, 200);
              await ctx.runtime.drain();
            }
            await assertNoTelegramDeliveries(ctx);
            const persisted = await readPersistedTelegramMessages(ctx);
            assert(persisted.ok);
            expect(await persisted.json()).toMatchObject({
              messages: [{ text: "verified update" }, { text: "verified update" }],
            });
            assert(
              !ctx.runtime.hasObjectInstance({
                binding: "TELEGRAM",
                scope: { kind: "org", orgId: "attacker-org" },
              }),
            );
          },
        ),
      ],
    });
  });

  test("members operate their own Telegram scopes without reaching foreign scopes", async () => {
    await runTelegramScenario({
      objects: scenarioObjects,
      name: "Telegram member requests use canonical operation permissions",
      fakes: ({ fake }) => ({ telegram: fake.telegram() }),
      setup: ({ given }) => [
        given.organization.exists({ id: orgId }),
        given.telegram.configured({ orgId, botUsername: "fragno_bot" }),
      ],
      steps: ({ when, then }) => [
        when.auth.signUp({
          email: "telegram-member@example.test",
          captureSessionCookieAs: "session",
        }),
        then.assert("members read and send only within their own scopes", async (ctx) => {
          const member = await authenticateTelegramUser(ctx, "user");
          const headers = { cookie: member.cookie };
          const invalidBearer = await callPublicTelegram(ctx, {
            scopePath,
            suffix: "/chats/1234/messages",
            method: "GET",
            headers: { ...headers, authorization: "Bearer forged-backoffice-token" },
            body: null,
          });
          assert.equal(invalidBearer.status, 401);
          for (const suffix of ["/chats", "/chats/1234/messages", "/commands"]) {
            const response = await callPublicTelegram(ctx, {
              scopePath,
              suffix,
              method: "GET",
              headers,
              body: null,
            });
            assert.equal(response.status, 200, await response.clone().text());
          }
          await ctx.runtime.objects.telegram
            .forUser({ userId: member.userId })
            .commands.setAdminConfig({
              botToken: "123456:telegram-bot-token",
              webhookSecretToken: webhookSecret,
              botUsername: "fragno_bot",
            });
          const privateManagement = await callPublicTelegram(ctx, {
            scopePath: `user%3A${member.userId}`,
            suffix: "/commands/bind",
            method: "POST",
            headers,
            body: { chatId: "1234", commandName: "start", enabled: false },
          });
          // Personal-scope management is authorized; the fragment itself rejects the unknown command.
          assert.equal(privateManagement.status, 404);
          expect(await privateManagement.json()).toMatchObject({ code: "command_not_found" });
          const privateCommands = await ctx.runtime.objects.telegram
            .forUser({ userId: member.userId })
            .http.fetchAuthorized(new Request("https://telegram.do/api/telegram/commands"), {
              execution: createBackofficeSystemExecution({ kind: "user", userId: member.userId }),
              propagationContext: null,
            });
          assert(privateCommands.ok);
          expect(await privateCommands.json()).toEqual({ commands: [] });
          for (const otherScope of [
            "org%3Aother-org",
            "project%3Aother-org%3Aproject-1",
            "user%3Aother-user",
            "system",
          ]) {
            const denied = await callPublicTelegram(ctx, {
              scopePath: otherScope,
              suffix: "/chats/1234/send",
              method: "POST",
              headers,
              body: { text: "cross-scope send", orgId, userId: member.userId },
            });
            assert.equal(denied.status, 403);
          }
          await assertNoTelegramDeliveries(ctx);
          for (const input of [
            { suffix: "/chats/1234/send?scope=org%3Aother-org", body: { text: "authorized send" } },
            { suffix: "/chats/1234/actions", body: { action: "typing" } },
            { suffix: "/chats/1234/messages/1/edit", body: { text: "authorized edit" } },
          ]) {
            const response = await callPublicTelegram(ctx, {
              ...input,
              scopePath,
              method: "POST",
              headers,
            });
            assert.equal(response.status, 200);
            await ctx.runtime.drain();
          }
          await ctx.runtime.drain();
          assert(ctx.fakes.telegram);
          expect(ctx.fakes.telegram.sendMessageCalls).toMatchObject([
            { body: { chat_id: "1234", text: "authorized send" } },
          ]);
          expect(ctx.fakes.telegram.sendChatActionCalls).toMatchObject([
            { body: { chat_id: "1234", action: "typing" } },
          ]);
          expect(ctx.fakes.telegram.editMessageTextCalls).toMatchObject([
            { body: { chat_id: "1234", text: "authorized edit" } },
          ]);
          const persisted = await readPersistedTelegramMessages(ctx);
          assert(persisted.ok);
          expect(await persisted.json()).toMatchObject({
            messages: expect.arrayContaining([
              expect.objectContaining({ text: "authorized send" }),
              expect.objectContaining({ text: "authorized edit" }),
            ]),
          });
          assert(
            !ctx.runtime.hasObjectInstance({
              binding: "TELEGRAM",
              scope: { kind: "org", orgId: "other-org" },
            }),
          );
        }),
      ],
    });
  });

  test("authorized administrators can inspect persisted chats without exposing internal download routes", async () => {
    await runTelegramScenario({
      objects: scenarioObjects,
      name: "Telegram public routes are a closed management surface",
      fakes: ({ fake }) => ({
        telegram: fake.telegram({
          files: [
            {
              fileId: "private-file",
              fileUniqueId: "unique-file",
              filePath: "documents/private.txt",
              fileSize: 7,
              bytes: new TextEncoder().encode("private"),
              contentType: "text/plain",
            },
          ],
        }),
      }),
      setup: ({ given }) => [
        given.organization.exists({ id: orgId, slug: "different-public-slug" }),
        given.telegram.configured({ orgId, botUsername: "fragno_bot" }),
      ],
      steps: ({ when, then }) => [
        when.auth.signUp({
          email: "telegram-admin@example.test",
          captureSessionCookieAs: "session",
        }),
        when.telegram.receivesMessage({
          orgId,
          updateId: 1,
          chatId: "1234",
          text: "private message",
        }),
        then.assert(
          "authorized reads work but internal and unknown paths never forward",
          async (ctx) => {
            const admin = await authenticateTelegramUser(ctx, "admin");
            const headers = { cookie: admin.cookie };
            for (const suffix of [
              "/chats",
              "/chats/1234",
              "/chats/1234/messages",
              "/commands?chatId=1234",
            ]) {
              const response = await callPublicTelegram(ctx, {
                scopePath,
                suffix,
                method: "GET",
                headers,
                body: null,
              });
              assert.equal(response.status, 200);
              if (suffix === "/chats/1234/messages") {
                expect(await response.json()).toMatchObject({
                  messages: [{ text: "private message" }],
                });
              }
            }
            const binding = await callPublicTelegram(ctx, {
              scopePath,
              suffix: "/commands/bind",
              method: "POST",
              headers,
              body: { chatId: "1234", commandName: "not-configured" },
            });
            assert.equal(binding.status, 404);
            expect(await binding.json()).toMatchObject({ code: "command_not_found" });
            for (const suffix of [
              telegramAutomationFileDownloadPath("private-file"),
              "/__backoffice/telegram/automation-files/private-file/extra",
              "/telegram/webhook/chats/1234/messages",
              "/chats/1234/messages/1/download",
              "/unknown-management-route",
            ]) {
              const response = await callPublicTelegram(ctx, {
                scopePath,
                suffix,
                method: "GET",
                headers,
                body: null,
              });
              assert.equal(response.status, 404);
            }
            assert(ctx.fakes.telegram);
            expect(ctx.fakes.telegram.getFileCalls).toEqual([]);
            expect(ctx.fakes.telegram.downloadFileCalls).toEqual([]);
            const internal = await ctx.runtime.objects.telegram
              .forOrg(orgId)
              .http.fetchAuthorized(
                new Request(
                  `https://telegram.do${telegramAutomationFileDownloadPath("private-file")}`,
                ),
                {
                  execution: createBackofficeSystemExecution({ kind: "org", orgId }),
                  propagationContext: null,
                },
              );
            assert(internal.ok);
            assert.equal(await internal.text(), "private");
            expect(ctx.fakes.telegram.downloadFileCalls).toEqual([{ fileId: "private-file" }]);
            await assertNoTelegramDeliveries(ctx);
          },
        ),
      ],
    });
  });
});
