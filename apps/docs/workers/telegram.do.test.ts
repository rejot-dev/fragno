import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const {
  migrateMock,
  createDurableHooksProcessorMock,
  createTelegramServerMock,
  loadDurableHookQueueMock,
  handlerMock,
  dispatcherAlarmMock,
} = vi.hoisted(() => ({
  migrateMock: vi.fn(async () => undefined),
  createDurableHooksProcessorMock: vi.fn(),
  createTelegramServerMock: vi.fn(),
  loadDurableHookQueueMock: vi.fn(),
  handlerMock: vi.fn(async () => new Response("ok", { status: 200 })),
  dispatcherAlarmMock: vi.fn(async () => undefined),
}));

vi.mock("cloudflare:workers", () => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  return { DurableObject: MockDurableObject };
});

vi.mock("@fragno-dev/db", () => ({
  migrate: migrateMock,
}));

vi.mock("@fragno-dev/db/dispatchers/cloudflare-do", () => ({
  createDurableHooksProcessor: createDurableHooksProcessorMock,
}));

vi.mock("@/fragno/telegram", () => ({
  createTelegramServer: createTelegramServerMock,
}));

vi.mock("@/fragno/durable-hooks", () => ({
  loadDurableHookQueue: loadDurableHookQueueMock,
}));

import { Telegram } from "./telegram.do";

const CONFIG_KEY = "telegram-config";
const ORG_ID_STORAGE_KEY = "telegram-org-id";

const VALID_PAYLOAD = {
  botToken: "123456:telegram-bot-token",
  webhookSecretToken: "telegram-webhook-secret",
  botUsername: "fragno_bot",
};

const createState = (initialEntries?: Array<[string, unknown]>) => {
  const store = new Map<string, unknown>(initialEntries);
  const storage = {
    get: vi.fn(async (key: string) => store.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
  };
  const waitUntil = vi.fn();

  return {
    store,
    state: { storage, waitUntil } as unknown as DurableObjectState,
  };
};

describe("Telegram Durable Object", () => {
  beforeEach(() => {
    migrateMock.mockClear();
    createDurableHooksProcessorMock.mockReset();
    createTelegramServerMock.mockReset();
    loadDurableHookQueueMock.mockReset();
    handlerMock.mockReset();
    dispatcherAlarmMock.mockReset();

    handlerMock.mockImplementation(async () => new Response("ok", { status: 200 }));
    createDurableHooksProcessorMock.mockImplementation(() => {
      return () => ({
        alarm: dispatcherAlarmMock,
      });
    });
    createTelegramServerMock.mockImplementation(() => ({
      handler: handlerMock,
    }));

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, description: "Webhook registered." }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("binds the fragment to the durable object's organisation", async () => {
    const { state, store } = createState();
    const telegram = new Telegram(state, {} as CloudflareEnv);

    await telegram.setAdminConfig(VALID_PAYLOAD, "acme", "https://example.com");

    expect(store.get(ORG_ID_STORAGE_KEY)).toBe("acme");
    expect(createTelegramServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        botToken: VALID_PAYLOAD.botToken,
        webhookSecretToken: VALID_PAYLOAD.webhookSecretToken,
        botUsername: VALID_PAYLOAD.botUsername,
      }),
      state,
      expect.objectContaining({ orgId: "acme" }),
    );
  });

  test("rejects attempts to rebind admin config to a different organisation", async () => {
    const { state } = createState();
    const telegram = new Telegram(state, {} as CloudflareEnv);

    await telegram.setAdminConfig(VALID_PAYLOAD, "acme", "https://example.com");

    await expect(
      telegram.setAdminConfig(VALID_PAYLOAD, "other-org", "https://example.com"),
    ).rejects.toThrowError('Telegram Durable Object is already bound to organisation "acme".');
  });

  test("rejects requests whose orgId does not match the bound durable object", async () => {
    const { state } = createState();
    const telegram = new Telegram(state, {} as CloudflareEnv);

    await telegram.setAdminConfig(VALID_PAYLOAD, "acme", "https://example.com");

    await expect(
      telegram.fetch(new Request("https://example.com/api/telegram/webhook?orgId=other-org")),
    ).rejects.toThrowError('Telegram Durable Object is already bound to organisation "acme".');
  });

  test("migrates legacy config orgId into the durable object's org binding", async () => {
    const createdAt = "2026-03-16T00:00:00.000Z";
    const { state, store } = createState([
      [
        CONFIG_KEY,
        {
          ...VALID_PAYLOAD,
          orgId: "acme",
          createdAt,
          updatedAt: createdAt,
        },
      ],
    ]);
    const telegram = new Telegram(state, {} as CloudflareEnv);

    const response = await telegram.fetch(
      new Request("https://example.com/api/telegram/webhook?orgId=acme"),
    );

    expect(response.status).toBe(200);
    expect(store.get(ORG_ID_STORAGE_KEY)).toBe("acme");
    expect(createTelegramServerMock).toHaveBeenCalledWith(
      expect.any(Object),
      state,
      expect.objectContaining({ orgId: "acme" }),
    );
  });
});
