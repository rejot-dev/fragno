import { beforeEach, describe, expect, test, vi, assert } from "vitest";

const {
  migrateMock,
  createDurableHooksProcessorMock,
  createCloudflareServerMock,
  resolveCloudflareDispatchNamespaceNameMock,
} = vi.hoisted(() => ({
  migrateMock: vi.fn(async () => undefined),
  createDurableHooksProcessorMock: vi.fn(),
  createCloudflareServerMock: vi.fn(),
  resolveCloudflareDispatchNamespaceNameMock: vi.fn(() => "staging"),
}));

vi.mock("cloudflare:workers", () => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  class MockRpcTarget {}

  return { DurableObject: MockDurableObject, RpcTarget: MockRpcTarget };
});

vi.mock("@fragno-dev/cloudflare-fragment", () => ({
  resolveCloudflareDispatchNamespaceName: resolveCloudflareDispatchNamespaceNameMock,
}));

vi.mock("@fragno-dev/db", () => ({
  migrate: migrateMock,
}));

vi.mock("@fragno-dev/db/dispatchers/cloudflare-do", () => ({
  createDurableHooksProcessor: createDurableHooksProcessorMock,
}));

vi.mock("@/fragno/cloudflare", () => ({
  createCloudflareServer: createCloudflareServerMock,
}));

import { CloudflareWorkers } from "./cloudflare-wfp.do";

const CONFIG_KEY = "cloudflare-workers-config";
const EMPTY_QUEUE = {
  configured: false,
  hooksEnabled: false,
  namespace: null,
  items: [],
  cursor: undefined,
  hasNextPage: false,
};

const createState = (initialStorage?: Record<string, unknown>) => {
  const store = new Map(Object.entries(initialStorage ?? {}));
  const storage = {
    get: vi.fn(async (key: string) => store.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
  };
  const waitUntil = vi.fn();
  const blockConcurrencyWhile = vi.fn(<T>(callback: () => Promise<T>) => {
    return callback();
  });

  const id = { toString: () => "cloudflare-workers:test" };

  return { id, storage, waitUntil, blockConcurrencyWhile } as unknown as DurableObjectState;
};

describe("CloudflareWorkers Durable Object", () => {
  beforeEach(() => {
    migrateMock.mockClear();
    createDurableHooksProcessorMock.mockReset();
    createCloudflareServerMock.mockReset();
    resolveCloudflareDispatchNamespaceNameMock.mockClear();
  });

  test("stores the first scope once and rejects rebinding to another scope", async () => {
    const state = createState();
    const workers = new CloudflareWorkers(state, {} as CloudflareEnv);

    await expect(
      workers.getDurableHookRepository().getHookQueue({ orgId: "  acme  " }),
    ).resolves.toEqual(EMPTY_QUEUE);

    expect(state.storage.put).toHaveBeenCalledTimes(1);
    expect(state.storage.put).toHaveBeenCalledWith(CONFIG_KEY, {
      scope: { kind: "org", orgId: "acme" },
    });

    await expect(
      workers.getDurableHookRepository().getHookQueue({ orgId: "other-org" }),
    ).rejects.toThrowError(
      "Cloudflare Workers Durable Object is already bound to a different scope.",
    );

    expect(state.storage.put).toHaveBeenCalledTimes(1);
  });

  test("accepts the same stored scope without rewriting storage", async () => {
    const state = createState({ [CONFIG_KEY]: { scope: { kind: "org", orgId: "acme" } } });
    const workers = new CloudflareWorkers(state, {} as CloudflareEnv);

    await expect(
      workers.getDurableHookRepository().getHookQueue({ orgId: " acme " }),
    ).resolves.toEqual(EMPTY_QUEUE);

    expect(state.storage.get).toHaveBeenCalledWith(CONFIG_KEY);
    expect(state.storage.put).not.toHaveBeenCalled();
  });

  test("rejects a different scope when one is already stored", async () => {
    const state = createState({ [CONFIG_KEY]: { scope: { kind: "org", orgId: "acme" } } });
    const workers = new CloudflareWorkers(state, {} as CloudflareEnv);

    await expect(
      workers.getDurableHookRepository().getHookQueue({ orgId: "other-org" }),
    ).rejects.toThrowError(
      "Cloudflare Workers Durable Object is already bound to a different scope.",
    );

    expect(state.storage.get).toHaveBeenCalledWith(CONFIG_KEY);
    expect(state.storage.put).not.toHaveBeenCalled();
  });

  test("returns a standard scope mismatch response for fetch requests", async () => {
    const state = createState({ [CONFIG_KEY]: { scope: { kind: "org", orgId: "acme" } } });
    const workers = new CloudflareWorkers(state, {} as CloudflareEnv);

    const response = await workers.fetch(
      new Request("https://example.com/api/cloudflare/workers?orgId=other-org"),
    );

    assert(response.status === 409);
    await expect(response.json()).resolves.toMatchObject({
      code: "SCOPE_MISMATCH",
      expectedScope: { kind: "org", orgId: "acme" },
      scope: { kind: "org", orgId: "other-org" },
    });
    expect(state.storage.put).not.toHaveBeenCalled();
  });
});
