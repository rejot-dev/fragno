import { afterEach, beforeEach, describe, expect, test, vi, assert } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  class MockRpcTarget {}
  class MockWorkerEntrypoint {}

  return {
    DurableObject: MockDurableObject,
    RpcTarget: MockRpcTarget,
    WorkerEntrypoint: MockWorkerEntrypoint,
  };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import type { TelegramApi, TelegramMessage } from "@fragno-dev/telegram-fragment";

import {
  createInMemoryBackofficeRuntime,
  type InMemoryBackofficeRuntime,
} from "@/backoffice-runtime/in-memory-runtime";
import { WORKSPACE_STARTER_CONTENT } from "@/files";

import { InMemoryTelegramObject } from "../../../workers/telegram.do";
import { createRouteBackedAutomationStoreRuntime } from "./bindings-route-runtime";
import { createTestMasterFileSystem } from "./engine/test-master-file-system.test-utils";

const createAutomationFileSystem = async () =>
  createTestMasterFileSystem(
    Object.fromEntries(
      Object.entries(WORKSPACE_STARTER_CONTENT).map(([path, content]) => [
        `/workspace/${path.replace(/^\/+/, "")}`,
        content,
      ]),
    ),
  );

const TELEGRAM_CHAT_ID = "1001";

type TelegramSendCall = {
  body: Record<string, unknown>;
};

type TelegramAdminApi = NonNullable<
  ConstructorParameters<typeof InMemoryTelegramObject>[0]["adminApi"]
>;

type FakeTelegramApis = {
  api: TelegramApi;
  adminApi: TelegramAdminApi;
  sendMessageCalls: TelegramSendCall[];
  setWebhookCalls: Parameters<TelegramAdminApi["setWebhook"]>[0][];
};

const createFakeTelegramApis = (): FakeTelegramApis => {
  const sendMessageCalls: TelegramSendCall[] = [];
  const setWebhookCalls: Parameters<TelegramAdminApi["setWebhook"]>[0][] = [];

  const buildMessage = (payload: Record<string, unknown>): TelegramMessage => ({
    messageId: sendMessageCalls.length,
    date: Math.floor(Date.now() / 1000),
    chat: {
      id: Number(payload.chat_id),
      type: "private",
    },
    text: String(payload.text ?? ""),
  });

  const normalizeMessagePayload = (payload: Record<string, unknown>) => ({
    ...payload,
    chat_id: payload.chat_id ?? payload.chatId,
  });

  return {
    sendMessageCalls,
    setWebhookCalls,
    adminApi: {
      setWebhook: async (input) => {
        setWebhookCalls.push(input);
        return { ok: true, message: "webhook set" };
      },
    },
    api: {
      call: async () => ({ ok: false, description: "Unsupported fake Telegram API call" }),
      sendMessage: async (payload) => {
        const normalizedPayload = normalizeMessagePayload(payload);
        sendMessageCalls.push({ body: normalizedPayload });
        return { ok: true, result: buildMessage(normalizedPayload) };
      },
      editMessageText: async (payload) => {
        const normalizedPayload = normalizeMessagePayload(payload);
        return { ok: true, result: buildMessage(normalizedPayload) };
      },
      sendChatAction: async () => ({ ok: true, result: true }),
    },
  };
};

const firstUrlInText = (text: string) => {
  const match = /https?:\/\/\S+/u.exec(text);
  if (!match) {
    throw new Error(`Expected text to contain a URL: ${text}`);
  }
  return new URL(match[0]);
};

describe("starter OTP linking automation in memory", () => {
  let runtime: InMemoryBackofficeRuntime | undefined;
  let telegramApis: FakeTelegramApis;

  beforeEach(() => {
    telegramApis = createFakeTelegramApis();
  });

  afterEach(async () => {
    await runtime?.cleanup();
    runtime = undefined;
  });

  test("routes Telegram /start through OTP confirmation and links the Telegram chat", async () => {
    const fileSystem = await createAutomationFileSystem();
    runtime = await createInMemoryBackofficeRuntime({
      env: {
        DOCS_PUBLIC_BASE_URL: "https://example.com",
      },
      getAutomationFileSystem: async () => fileSystem,
      objectFactories: {
        TELEGRAM: ({ state, runtime }) =>
          new InMemoryTelegramObject({
            state,
            runtime,
            api: telegramApis.api,
            adminApi: telegramApis.adminApi,
          }),
      },
    });

    await runtime.objects.telegram.forOrg("org-1").setAdminConfig(
      {
        orgId: "org-1",
        botToken: "123456:telegram-bot-token",
        webhookSecretToken: "telegram-webhook-secret",
        botUsername: "fragno_bot",
        apiBaseUrl: "https://telegram.test",
        webhookBaseUrl: "https://example.com",
      },
      "https://example.com",
    );
    await runtime.drain();

    const telegramChat = {
      id: Number(TELEGRAM_CHAT_ID),
      type: "private",
      first_name: "Ada",
      username: "ada_lovelace",
    };

    const webhookResponse = await runtime.objects.telegram.forOrg("org-1").fetch(
      new Request("https://telegram.do/api/telegram/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "telegram-webhook-secret",
        },
        body: JSON.stringify({
          update_id: 10_001,
          message: {
            message_id: 501,
            date: 1_780_000_000,
            text: "/start",
            from: {
              id: 2_001,
              is_bot: false,
              first_name: "Ada",
              username: "ada_lovelace",
            },
            chat: telegramChat,
          },
        }),
      }),
    );
    expect(await webhookResponse.json()).toEqual({ ok: true });
    await runtime.drain();

    expect(telegramApis.setWebhookCalls).toHaveLength(1);
    expect(telegramApis.sendMessageCalls).toHaveLength(1);
    expect(telegramApis.sendMessageCalls[0]?.body).toEqual(
      expect.objectContaining({
        chat_id: TELEGRAM_CHAT_ID,
        text: expect.stringContaining("Open this link to finish linking your Telegram account"),
      }),
    );

    const claimUrl = firstUrlInText(String(telegramApis.sendMessageCalls[0]?.body.text));
    assert(claimUrl.pathname === "/backoffice/automations/org-1/claims/complete");
    const externalId = claimUrl.searchParams.get("externalId");
    const code = claimUrl.searchParams.get("code");
    expect(externalId).toEqual(expect.any(String));
    expect(code).toEqual(expect.any(String));

    await expect(
      runtime.objects.otp.forOrg("org-1").confirmIdentityClaim({
        externalId: externalId!,
        code: code!,
        subjectUserId: "user-1",
      }),
    ).resolves.toEqual({ ok: true, externalId });
    await runtime.drain();

    const store = createRouteBackedAutomationStoreRuntime({
      objects: runtime.objects,
      orgId: "org-1",
    });
    await expect(store.get({ key: `telegram/${TELEGRAM_CHAT_ID}` })).resolves.toEqual(
      expect.objectContaining({
        key: `telegram/${TELEGRAM_CHAT_ID}`,
        value: "user-1",
      }),
    );

    expect(telegramApis.sendMessageCalls).toHaveLength(2);
    expect(telegramApis.sendMessageCalls[1]?.body).toEqual(
      expect.objectContaining({
        chat_id: TELEGRAM_CHAT_ID,
        text: "Your Telegram chat is now linked.",
      }),
    );
  });
});
