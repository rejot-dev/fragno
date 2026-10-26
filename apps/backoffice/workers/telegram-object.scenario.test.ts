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

import {
  createBackofficeServiceExecution,
  createBackofficeSystemExecution,
} from "@/backoffice-runtime/context";
import {
  BACKOFFICE_INTERNAL_CONTEXT_HEADER,
  createAuthorizedBackofficeObjectRequest,
} from "@/backoffice-runtime/internal-object-request";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { telegramAutomationFileDownloadPath } from "@/backoffice-runtime/telegram-file-response";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
  type BackofficeScenarioDefinitionInput,
} from "@/fragno/automation/scenario";
import { createTelegramRuntime } from "@/fragno/runtime-tools/families/telegram-runtime";

import { ApiObject } from "./api-object";
import { AuthObject } from "./auth-object";
import { AutomationsObject } from "./automations-object";
import { FormsObject } from "./forms-object";
import { TelegramObject } from "./telegram-object";
import { UploadObject } from "./upload-object";

const scenarioObjects = {
  API: (input) => new ApiObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  FORMS: (input) => new FormsObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

const scope = { kind: "org", orgId: "telegram-org" } as const;
const address = { binding: "TELEGRAM", scope } as const;

async function runTelegramObjectScenario(scenario: BackofficeScenarioDefinitionInput) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-telegram-object-security-"));
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

async function assertTelegramStateUnchanged(ctx: BackofficeScenarioContext) {
  await ctx.runtime.drain();
  assert(ctx.fakes.telegram);
  expect(ctx.fakes.telegram.sendMessageCalls).toEqual([]);
  expect(ctx.fakes.telegram.editMessageTextCalls).toEqual([]);
  expect(ctx.fakes.telegram.sendChatActionCalls).toEqual([]);
  expect(ctx.fakes.telegram.downloadFileCalls).toEqual([]);
  const object = ctx.runtime.objects.telegram.for(scope);
  const queue = await object.commands.getDurableHookQueue();
  expect(queue.items.filter((hook) => hook.hookName === "internalOutgoingMessage")).toEqual([]);
  const messages = await object.http.fetchAuthorized(
    new Request("https://telegram.do/api/telegram/chats/1234/messages"),
    { execution: createBackofficeSystemExecution(scope), propagationContext: null },
  );
  assert(messages.ok);
  expect(await messages.json()).toMatchObject({ messages: [{ text: "private message" }] });
}

/** Sends requests to the object itself; handle HTTP strips the internal context header. */
function nativeTelegramObject(ctx: BackofficeScenarioContext, orgId: string) {
  return ctx.runtime.objects.telegram.forOrg(orgId).commands as unknown as Pick<
    TelegramObject,
    "fetch"
  >;
}

describe("Telegram object authorization scenarios", () => {
  test("direct object requests cannot bypass management or download authorization", async () => {
    await runTelegramObjectScenario({
      objects: scenarioObjects,
      name: "Telegram native fetch requires trusted execution",
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
        given.organization.exists({ id: scope.orgId }),
        given.telegram.configured({ orgId: scope.orgId, botUsername: "fragno_bot" }),
      ],
      steps: ({ when, then }) => [
        when.telegram.receivesMessage({
          orgId: scope.orgId,
          updateId: 1,
          chatId: "1234",
          text: "private message",
        }),
        then.assert(
          "unsigned and forged contexts never reach handlers or transports",
          async (ctx) => {
            const object = ctx.runtime.objects.telegram.for(scope);
            for (const input of [
              { method: "GET", path: "/api/telegram/chats", body: null },
              { method: "GET", path: "/api/telegram/chats/1234/messages", body: null },
              { method: "GET", path: "/api/telegram/commands", body: null },
              {
                method: "POST",
                path: "/api/telegram/chats/1234/send",
                body: { text: "forged send" },
              },
              {
                method: "POST",
                path: "/api/telegram/chats/1234/actions",
                body: { action: "typing" },
              },
              {
                method: "POST",
                path: "/api/telegram/chats/1234/messages/1/edit",
                body: { text: "forged edit" },
              },
              {
                method: "POST",
                path: "/api/telegram/commands/bind",
                body: { chatId: "1234", commandName: "start" },
              },
              {
                method: "GET",
                path: telegramAutomationFileDownloadPath("private-file"),
                body: null,
              },
            ]) {
              for (const envelope of [null, "forged-internal-authority"]) {
                const headers = new Headers({
                  "content-type": "application/json",
                  "x-telegram-bot-api-secret-token": "telegram-webhook-secret",
                  "x-user-role": "admin",
                });
                if (envelope !== null) {
                  headers.set(BACKOFFICE_INTERNAL_CONTEXT_HEADER, envelope);
                }
                const response = await object.http.fetch(
                  new Request(`https://telegram.do${input.path}`, {
                    method: input.method,
                    headers,
                    ...(input.method === "GET" ? {} : { body: JSON.stringify(input.body) }),
                  }),
                );
                assert.equal(response.status, 401);
                expect(await response.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
              }
            }
            for (const input of [
              { method: "GET", path: "/api/telegram/telegram/webhook" },
              { method: "POST", path: "/api/telegram/telegram/webhook/" },
            ]) {
              const response = await object.http.fetch(
                new Request(`https://telegram.do${input.path}`, {
                  method: input.method,
                  headers: {
                    "content-type": "application/json",
                    "x-telegram-bot-api-secret-token": "telegram-webhook-secret",
                  },
                  ...(input.method === "POST" ? { body: JSON.stringify({ update_id: 999 }) } : {}),
                }),
              );
              assert.equal(response.status, 404);
            }
            await assertTelegramStateUnchanged(ctx);
          },
        ),
      ],
    });
  });

  test("middleware enforces operation grants on signed native requests", async () => {
    await runTelegramObjectScenario({
      objects: scenarioObjects,
      name: "Telegram direct signed requests retain kernel permission checks",
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
        given.organization.exists({ id: scope.orgId }),
        given.telegram.configured({ orgId: scope.orgId, botUsername: "fragno_bot" }),
      ],
      steps: ({ when, then }) => [
        when.telegram.receivesMessage({
          orgId: scope.orgId,
          updateId: 1,
          chatId: "1234",
          text: "private message",
          messageId: 100,
        }),
        then.assert("trusted scope context alone does not grant bot access", async (ctx) => {
          const object = ctx.runtime.objects.telegram.for(scope);
          // Agents hold no integrations.execute, which every bot read and send requires.
          const agent = {
            execution: createBackofficeServiceExecution({
              scope,
              service: { type: "agent", id: "telegram-sender" },
            }),
            propagationContext: null,
          };
          for (const path of [
            "/api/telegram/chats",
            "/api/telegram/chats/1234",
            "/api/telegram/chats/1234/messages",
            "/api/telegram/commands",
            telegramAutomationFileDownloadPath("private-file"),
          ]) {
            const response = await object.http.fetchAuthorized(
              new Request(`https://telegram.do${path}`),
              agent,
            );
            assert.equal(response.status, 403);
            expect(await response.json()).toMatchObject({ code: "principal-permission-denied" });
          }
          const deniedSend = await object.http.fetchAuthorized(
            new Request("https://telegram.do/api/telegram/chats/1234/send", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ text: "agent send" }),
            }),
            agent,
          );
          assert.equal(deniedSend.status, 403);
          const unlisted = await object.http.fetchAuthorized(
            new Request("https://telegram.do/api/telegram/_internal"),
            {
              execution: createBackofficeSystemExecution(scope),
              propagationContext: null,
            },
          );
          assert.equal(unlisted.status, 404);
          expect(await unlisted.json()).toMatchObject({ code: "FRAGMENT_ROUTE_NOT_EXPOSED" });
          const kernel = new BackofficeKernel(ctx.runtime.services);
          const agentRuntime = createTelegramRuntime({
            object,
            execution: agent.execution,
            kernel,
          });
          await expect(agentRuntime.getFile({ fileId: "private-file" })).rejects.toMatchObject({
            reason: "principal-permission-denied",
          });
          await expect(agentRuntime.downloadFile({ fileId: "private-file" })).rejects.toMatchObject(
            { reason: "principal-permission-denied" },
          );
          await assertTelegramStateUnchanged(ctx);
          const trusted = {
            execution: createBackofficeSystemExecution(scope),
            propagationContext: null,
          };
          const sent = await object.http.fetchAuthorized(
            new Request("https://telegram.do/api/telegram/chats/1234/send", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ text: "authorized send" }),
            }),
            trusted,
          );
          assert.equal(sent.status, 200);
          await ctx.runtime.drain();
          assert(ctx.fakes.telegram);
          expect(ctx.fakes.telegram.sendMessageCalls).toMatchObject([
            { body: { chat_id: "1234", text: "authorized send" } },
          ]);
          const runtime = createTelegramRuntime({ object, execution: trusted.execution, kernel });
          const queued = await runtime.sendMessage({
            chatId: "1234",
            text: "runtime send",
            parseMode: null,
            disableWebPagePreview: false,
            replyToMessageId: null,
          });
          expect(queued).toEqual({ ok: true, queued: true });
          await ctx.runtime.drain();
          expect(ctx.fakes.telegram.sendMessageCalls).toMatchObject([
            { body: { text: "authorized send" } },
            { body: { text: "runtime send" } },
          ]);
          const messages = await object.http.fetchAuthorized(
            new Request("https://telegram.do/api/telegram/chats/1234/messages"),
            {
              execution: createBackofficeSystemExecution(scope),
              propagationContext: null,
            },
          );
          assert(messages.ok);
          expect(await messages.json()).toMatchObject({
            messages: expect.arrayContaining([
              expect.objectContaining({ text: "private message" }),
              expect.objectContaining({ text: "authorized send" }),
              expect.objectContaining({ text: "runtime send" }),
            ]),
          });
          const file = await object.http.fetchAuthorized(
            new Request(`https://telegram.do${telegramAutomationFileDownloadPath("private-file")}`),
            {
              execution: createBackofficeSystemExecution(scope),
              propagationContext: null,
            },
          );
          assert(file.ok);
          assert.equal(await file.text(), "private");
          expect(ctx.fakes.telegram.downloadFileCalls).toEqual([{ fileId: "private-file" }]);
        }),
      ],
    });
  });

  test("signed execution cannot be moved to another scope, target, method, or lifetime", async () => {
    await runTelegramObjectScenario({
      objects: scenarioObjects,
      name: "Telegram signed context remains bound to its owning object and request",
      fakes: ({ fake }) => ({ telegram: fake.telegram() }),
      setup: ({ given }) => [
        given.organization.exists({ id: scope.orgId }),
        given.telegram.configured({ orgId: scope.orgId, botUsername: "fragno_bot" }),
      ],
      steps: ({ when, then }) => [
        when.telegram.receivesMessage({
          orgId: scope.orgId,
          updateId: 1,
          chatId: "1234",
          text: "private message",
        }),
        then.assert("invalid signed provenance is rejected before side effects", async (ctx) => {
          const context = {
            execution: createBackofficeSystemExecution(scope),
            propagationContext: null,
          };
          const env = ctx.runtime.env as unknown as CloudflareEnv;
          const request = new Request("https://telegram.do/api/telegram/chats/1234/messages");
          const signed = await createAuthorizedBackofficeObjectRequest({
            request,
            address,
            context,
            env,
            nowEpochMs: ctx.runtime.now(),
          });
          const stub = nativeTelegramObject(ctx, scope.orgId);
          const valid = await stub.fetch(new Request(signed.url, { headers: signed.headers }));
          assert.equal(valid.status, 200);
          const forged = await stub.fetch(
            new Request(request.url, {
              headers: { [BACKOFFICE_INTERNAL_CONTEXT_HEADER]: "forged-internal-authority" },
            }),
          );
          assert.equal(forged.status, 401);
          for (const target of [
            "https://telegram.do/api/telegram/chats",
            "https://telegram.do/api/telegram/chats/1234/messages?scope=org%3Aother-org",
            `https://telegram.do${telegramAutomationFileDownloadPath("private-file")}`,
          ]) {
            const response = await stub.fetch(new Request(target, { headers: signed.headers }));
            assert.equal(response.status, 401);
          }
          const changedMethod = await stub.fetch(
            new Request(signed.url, { method: "POST", headers: signed.headers, body: "{}" }),
          );
          assert.equal(changedMethod.status, 401);
          const otherObject = nativeTelegramObject(ctx, "other-org");
          const wrongObject = await otherObject.fetch(
            new Request(signed.url, { headers: signed.headers }),
          );
          assert.equal(wrongObject.status, 401);
          const wrongExecution = await ctx.runtime.objects.telegram
            .for(scope)
            .http.fetchAuthorized(request, {
              execution: createBackofficeSystemExecution({ kind: "org", orgId: "other-org" }),
              propagationContext: null,
            });
          assert.equal(wrongExecution.status, 401);
          const expired = await createAuthorizedBackofficeObjectRequest({
            request,
            address,
            context,
            env,
            nowEpochMs: ctx.runtime.now() - 30_001,
          });
          const expiredResponse = await stub.fetch(
            new Request(expired.url, { headers: expired.headers }),
          );
          assert.equal(expiredResponse.status, 401);
          await assertTelegramStateUnchanged(ctx);
        }),
      ],
    });
  });
});
