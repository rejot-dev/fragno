import { beforeEach, describe, expect, test, vi, assert } from "vitest";

const {
  migrateMock,
  createDurableHooksProcessorMock,
  createUploadServerForProviderMock,
  loadDurableHookQueueMock,
  loadDurableHookMock,
  dispatcherNotifyMock,
  dispatcherAlarmMock,
} = vi.hoisted(() => ({
  migrateMock: vi.fn(async () => undefined),
  createDurableHooksProcessorMock: vi.fn(),
  createUploadServerForProviderMock: vi.fn(),
  loadDurableHookQueueMock: vi.fn(),
  loadDurableHookMock: vi.fn(),
  dispatcherNotifyMock: vi.fn(async () => undefined),
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

vi.mock("@/fragno/upload", async () => {
  return await import("../app/fragno/upload");
});

vi.mock("@/fragno/upload-server", () => ({
  createUploadServerForProvider: createUploadServerForProviderMock,
}));

import type { BackofficeDurableHookDependencies } from "./lib/backoffice-fragment-durable-object";
import { Upload } from "./upload.do";

const createState = () => {
  const store = new Map<string, unknown>();
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
  const blockConcurrencyWhile = vi.fn(<T>(callback: () => Promise<T>) => {
    return callback();
  });

  return {
    id: { toString: () => "upload:test" },
    storage,
    waitUntil,
    blockConcurrencyWhile,
  } as unknown as DurableObjectState;
};

const VALID_R2_PAYLOAD = {
  provider: "r2",
  defaultProvider: "r2",
  bucket: "acme-upload-bucket",
  endpoint: "https://123456.r2.cloudflarestorage.com",
  accessKeyId: "abcd1234efgh5678",
  secretAccessKey: "secret1234abcd5678",
  region: "auto",
  pathStyle: true,
};

const VALID_R2_BINDING_PAYLOAD = {
  provider: "r2-binding",
  defaultProvider: "r2-binding",
  bindingName: "UPLOAD_BUCKET",
};

const VALID_DATABASE_PAYLOAD = {
  provider: "database",
  defaultProvider: "database",
};

const testDurableHookDependencies: BackofficeDurableHookDependencies = {
  createEmptyRepository: () => ({
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
  createRepository: <TOptions>(selectFragment: (options: TOptions | undefined) => unknown) => ({
    getHookQueue: (options?: TOptions) =>
      loadDurableHookQueueMock(selectFragment(options), options),
    getHook: (hookId: string, options?: TOptions) =>
      loadDurableHookMock(selectFragment(options), hookId),
  }),
  createRpcTarget: (repository) => repository,
};

describe("Upload Durable Object", () => {
  beforeEach(() => {
    migrateMock.mockClear();
    createDurableHooksProcessorMock.mockReset();
    createUploadServerForProviderMock.mockReset();
    loadDurableHookQueueMock.mockReset();
    loadDurableHookMock.mockReset();
    dispatcherNotifyMock.mockReset();
    dispatcherAlarmMock.mockReset();
    createDurableHooksProcessorMock.mockImplementation(() => {
      return () => ({
        notify: dispatcherNotifyMock,
        alarm: dispatcherAlarmMock,
      });
    });
    createUploadServerForProviderMock.mockImplementation((_config, provider) => ({
      handler: vi.fn(async () => new Response(`fragment-${provider}`, { status: 200 })),
    }));
  });

  test("returns NOT_CONFIGURED until admin config is saved", async () => {
    const state = createState();
    const upload = new Upload(state, {} as CloudflareEnv);

    const response = await upload.fetch(new Request("https://example.com/api/upload/files"));

    assert(response.status === 400);
    await expect(response.json()).resolves.toMatchObject({
      code: "NOT_CONFIGURED",
    });
  });

  test("stores multi-provider config and routes requests by provider", async () => {
    const state = createState();
    const r2Handler = vi.fn(async () => new Response("r2-ok", { status: 200 }));
    const bindingHandler = vi.fn(async () => new Response("binding-ok", { status: 200 }));

    createUploadServerForProviderMock.mockImplementation((_config, provider) => ({
      handler: provider === "r2" ? r2Handler : bindingHandler,
    }));

    const upload = new Upload(state, {} as CloudflareEnv);

    await upload.setAdminConfig(VALID_R2_BINDING_PAYLOAD, "acme");
    const config = await upload.setAdminConfig(
      {
        ...VALID_R2_PAYLOAD,
        defaultProvider: "r2",
      },
      "acme",
    );

    assert(config.defaultProvider === "r2");
    assert(config.providers["r2-binding"]?.configured);
    assert(config.providers.r2?.configured);

    const bindingResponse = await upload.fetch(
      new Request("https://example.com/api/upload/files?provider=r2-binding"),
    );
    assert(bindingResponse.status === 200);
    await expect(bindingResponse.text()).resolves.toBe("binding-ok");

    const r2Response = await upload.fetch(
      new Request("https://example.com/api/upload/files?provider=r2"),
    );
    assert(r2Response.status === 200);
    await expect(r2Response.text()).resolves.toBe("r2-ok");

    expect(bindingHandler).toHaveBeenCalled();
    expect(r2Handler).toHaveBeenCalled();
    expect(createUploadServerForProviderMock).toHaveBeenCalled();
    expect(createDurableHooksProcessorMock).toHaveBeenCalled();
    expect(migrateMock).toHaveBeenCalled();
  });

  test("schedules durable hook processing for requests handled by a secondary provider", async () => {
    const state = createState();
    const r2Handler = vi.fn(async () => new Response("r2-ok", { status: 200 }));
    const bindingHandler = vi.fn(async () => new Response("binding-ok", { status: 200 }));

    createUploadServerForProviderMock.mockImplementation((_config, provider) => ({
      handler: provider === "r2" ? r2Handler : bindingHandler,
    }));

    const upload = new Upload(state, {} as CloudflareEnv);
    await upload.setAdminConfig(VALID_R2_BINDING_PAYLOAD, "acme");
    await upload.setAdminConfig(
      {
        ...VALID_R2_PAYLOAD,
        defaultProvider: "r2",
      },
      "acme",
    );

    await upload.fetch(new Request("https://example.com/api/upload/files?provider=r2-binding"));

    expect(bindingHandler).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ waitUntil: expect.any(Function) }),
    );
    expect(dispatcherNotifyMock).toHaveBeenCalledTimes(1);
    expect(dispatcherNotifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: "request" }),
    );
  });

  test("delegates alarms to the durable hook dispatcher", async () => {
    const state = createState();
    const upload = new Upload(state, {} as CloudflareEnv);
    await upload.setAdminConfig(VALID_R2_PAYLOAD, "acme");

    await upload.alarm();

    expect(dispatcherAlarmMock).toHaveBeenCalledTimes(1);
  });

  test("rejects unsupported provider in request payload/query", async () => {
    const state = createState();
    const upload = new Upload(state, {} as CloudflareEnv);
    await upload.setAdminConfig(VALID_R2_PAYLOAD, "acme");

    const response = await upload.fetch(
      new Request("https://example.com/api/upload/files?provider=s3"),
    );

    assert(response.status === 400);
    await expect(response.json()).resolves.toMatchObject({
      code: "INVALID_PROVIDER",
    });
  });

  test("rejects invalid admin payload", async () => {
    const state = createState();
    const upload = new Upload(state, {} as CloudflareEnv);

    await expect(upload.setAdminConfig({ provider: "s3" }, "acme")).rejects.toThrowError(
      "Only providers 'database', 'r2', and 'r2-binding' are supported.",
    );
  });

  test("stores database config and routes requests by provider", async () => {
    const state = createState();
    const upload = new Upload(state, {} as CloudflareEnv);

    const config = await upload.setAdminConfig(VALID_DATABASE_PAYLOAD, "acme");

    assert(config.defaultProvider === "database");
    assert(config.providers.database?.configured);

    const response = await upload.fetch(new Request("https://example.com/api/upload/files"));

    assert(response.status === 200);
    await expect(response.text()).resolves.toBe("fragment-database");
    expect(createUploadServerForProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ defaultProvider: "database" }),
      "database",
      expect.objectContaining({
        adapters: expect.objectContaining({
          createAdapter: expect.any(Function),
        }),
      }),
      expect.any(Object),
    );
  });

  test("returns empty queue when upload is not configured", async () => {
    const state = createState();
    const upload = new Upload(state, {} as CloudflareEnv, testDurableHookDependencies);

    const queue = await upload.getDurableHookRepository().then((repo) => repo.getHookQueue());

    expect(queue).toEqual({
      configured: false,
      hooksEnabled: false,
      namespace: null,
      items: [],
      cursor: undefined,
      hasNextPage: false,
    });
    expect(loadDurableHookQueueMock).not.toHaveBeenCalled();
  });

  test("loads durable hook queue when upload is configured", async () => {
    const state = createState();
    const fragment = { handler: vi.fn(async () => new Response("ok")) };
    createUploadServerForProviderMock.mockReturnValue(fragment);
    loadDurableHookQueueMock.mockResolvedValue({
      configured: true,
      hooksEnabled: true,
      namespace: "upload",
      items: [],
      cursor: undefined,
      hasNextPage: false,
    });

    const upload = new Upload(state, {} as CloudflareEnv, testDurableHookDependencies);
    await upload.setAdminConfig(VALID_R2_PAYLOAD, "acme");

    const queue = await upload
      .getDurableHookRepository()
      .then((repo) => repo.getHookQueue({ pageSize: 10 }));

    expect(queue).toMatchObject({
      configured: true,
      hooksEnabled: true,
      namespace: "upload",
      items: [],
      hasNextPage: false,
    });
    expect(loadDurableHookQueueMock).toHaveBeenCalledTimes(1);
    expect(loadDurableHookQueueMock).toHaveBeenCalledWith(
      expect.objectContaining({ handler: expect.any(Function) }),
      expect.objectContaining({ pageSize: 10 }),
    );
  });
});
