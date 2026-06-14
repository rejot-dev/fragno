import { afterEach, beforeEach, describe, expect, test, vi, assert } from "vitest";

const {
  migrateMock,
  createDurableHooksProcessorMock,
  createTelegramServerMock,
  loadDurableHookQueueMock,
  loadDurableHookMock,
  handlerMock,
  dispatcherAlarmMock,
} = vi.hoisted(() => ({
  migrateMock: vi.fn(async () => undefined),
  createDurableHooksProcessorMock: vi.fn(),
  createTelegramServerMock: vi.fn(),
  loadDurableHookQueueMock: vi.fn(),
  loadDurableHookMock: vi.fn(),
  handlerMock: vi.fn(async () => new Response("ok", { status: 200 })),
  dispatcherAlarmMock: vi.fn(async () => undefined),
}));

vi.mock("cloudflare:workers", () => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  class MockRpcTarget {}

  return { DurableObject: MockDurableObject, RpcTarget: MockRpcTarget };
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
  loadDurableHook: loadDurableHookMock,
  createDurableHookRepository: (selectFragment: (options: unknown) => unknown) => ({
    getHookQueue: (options: unknown) => loadDurableHookQueueMock(selectFragment(options), options),
    getHook: (hookId: string, options: unknown) =>
      loadDurableHookMock(selectFragment(options), hookId),
  }),
  createDurableHookRepositoryRpcTarget: <T>(repository: T) => repository,
  createEmptyDurableHookRepository: () => ({
    getHookQueue: async () => ({
      configured: false,
      hooksEnabled: false,
      namespace: null,
      items: [],
      cursor: undefined,
      hasNextPage: false,
    }),
    getHook: async () => null,
  }),
}));

import { Telegram } from "./telegram.do";

const CONFIG_KEY = "telegram-config";

const VALID_PAYLOAD = {
  orgId: "acme",
  botToken: "123456:telegram-bot-token",
  webhookSecretToken: "telegram-webhook-secret",
  botUsername: "fragno_bot",
  webhookBaseUrl: "https://example.com",
};

const createState = (initialEntries?: Array<[string, unknown]>) => {
  const store = new Map<string, unknown>(initialEntries);
  let alarm: number | null = null;
  const storage = {
    get: vi.fn(async (key: string) => store.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    getAlarm: vi.fn(async () => alarm),
    setAlarm: vi.fn(async (scheduledTime: number) => {
      alarm = scheduledTime;
    }),
  };
  const waitUntil = vi.fn();
  let blockConcurrencyPromise: Promise<unknown> | undefined;
  const blockConcurrencyWhile = vi.fn(<T>(callback: () => Promise<T>) => {
    blockConcurrencyPromise = Promise.resolve().then(callback);
    return blockConcurrencyPromise as Promise<T>;
  });

  return {
    store,
    state: {
      id: { toString: () => "telegram:test" },
      storage,
      waitUntil,
      blockConcurrencyWhile,
    } as unknown as DurableObjectState,
    waitForBlockConcurrency: async () => await blockConcurrencyPromise,
  };
};

describe("Telegram Durable Object", () => {
  beforeEach(() => {
    migrateMock.mockClear();
    createDurableHooksProcessorMock.mockReset();
    createTelegramServerMock.mockReset();
    loadDurableHookQueueMock.mockReset();
    loadDurableHookMock.mockReset();
    handlerMock.mockReset();
    dispatcherAlarmMock.mockReset();

    handlerMock.mockImplementation(async () => new Response("ok", { status: 200 }));
    createDurableHooksProcessorMock.mockImplementation(() => {
      return () => ({
        alarm: dispatcherAlarmMock,
      });
    });
    createTelegramServerMock.mockImplementation(() => ({
      name: "telegram",
      $internal: { durableHooksToken: {} },
      handler: handlerMock,
    }));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

        if (url.includes("/setWebhook")) {
          return new Response(JSON.stringify({ ok: true, description: "Webhook registered." }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (url.includes("/getFile")) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                file_id: "telegram-file-1",
                file_unique_id: "unique-file-1",
                file_path: "voice/telegram-file-1.ogg",
                file_size: 4,
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        if (url.includes("/file/bot123456:telegram-bot-token/voice/telegram-file-1.ogg")) {
          return new Response(new Uint8Array([0, 255, 1, 2]), {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          });
        }

        return new Response("Not Found", { status: 404 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("binds the fragment to the durable object's organisation", async () => {
    const { state, store } = createState();
    const telegram = new Telegram(state, {} as CloudflareEnv);

    await telegram.setAdminConfig(VALID_PAYLOAD, "https://example.com");

    expect(store.get(CONFIG_KEY)).toMatchObject({ orgId: "acme" });
    expect(createTelegramServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        botToken: VALID_PAYLOAD.botToken,
        webhookSecretToken: VALID_PAYLOAD.webhookSecretToken,
        botUsername: VALID_PAYLOAD.botUsername,
      }),
      expect.objectContaining({
        adapters: expect.objectContaining({
          createAdapter: expect.any(Function),
        }),
      }),
      expect.objectContaining({
        hooks: expect.objectContaining({
          onMessageReceived: expect.any(Function),
        }),
      }),
    );
  });

  test("uses the configured Telegram API base URL when registering the webhook", async () => {
    const { state } = createState();
    const telegram = new Telegram(state, {} as CloudflareEnv);

    await telegram.setAdminConfig(
      { ...VALID_PAYLOAD, apiBaseUrl: "https://telegram.example" },
      "https://example.com",
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://telegram.example/bot123456:telegram-bot-token/setWebhook",
      expect.any(Object),
    );
  });

  test("rejects attempts to rebind admin config to a different organisation", async () => {
    const { state } = createState();
    const telegram = new Telegram(state, {} as CloudflareEnv);

    await telegram.setAdminConfig(VALID_PAYLOAD, "https://example.com");

    await expect(
      telegram.setAdminConfig({ ...VALID_PAYLOAD, orgId: "other-org" }, "https://example.com"),
    ).rejects.toThrowError('Telegram Durable Object is already bound to organisation "acme".');
  });

  test("rejects requests whose orgId does not match the bound durable object", async () => {
    const { state } = createState();
    const telegram = new Telegram(state, {} as CloudflareEnv);

    await telegram.setAdminConfig(VALID_PAYLOAD, "https://example.com");

    const response = await telegram.fetch(
      new Request("https://example.com/api/telegram/webhook?orgId=other-org"),
    );

    await expect(response.json()).resolves.toMatchObject({
      code: "ORG_ID_MISMATCH",
      expectedOrgId: "acme",
      orgId: "other-org",
    });
    assert(response.status === 409);
  });

  test("rejects stored config without an org id during initialization", async () => {
    const createdAt = "2026-03-16T00:00:00.000Z";
    const { state, waitForBlockConcurrency } = createState([
      [
        CONFIG_KEY,
        {
          botToken: VALID_PAYLOAD.botToken,
          webhookSecretToken: VALID_PAYLOAD.webhookSecretToken,
          botUsername: VALID_PAYLOAD.botUsername,
          createdAt,
          updatedAt: createdAt,
        },
      ],
    ]);
    new Telegram(state, {} as CloudflareEnv);

    await expect(waitForBlockConcurrency()).rejects.toThrowError(
      "Stored Telegram config is missing an organisation id.",
    );
  });

  test("resolves normalized automation file metadata through Telegram getFile", async () => {
    const { state } = createState();
    const telegram = new Telegram(state, {} as CloudflareEnv);

    await telegram.setAdminConfig(VALID_PAYLOAD, "https://example.com");

    await expect(telegram.getAutomationFile({ fileId: "telegram-file-1" })).resolves.toEqual({
      fileId: "telegram-file-1",
      fileUniqueId: "unique-file-1",
      filePath: "voice/telegram-file-1.ogg",
      fileSize: 4,
    });
  });

  test("downloads raw automation file bytes through Telegram file endpoint", async () => {
    const { state } = createState();
    const telegram = new Telegram(state, {} as CloudflareEnv);

    await telegram.setAdminConfig(VALID_PAYLOAD, "https://example.com");

    const response = await telegram.downloadAutomationFile({ fileId: "telegram-file-1" });
    expect(response).toBeInstanceOf(Response);
    assert(response.ok);
    await expect(response.arrayBuffer().then((buf) => new Uint8Array(buf))).resolves.toEqual(
      new Uint8Array([0, 255, 1, 2]),
    );
  });
});
