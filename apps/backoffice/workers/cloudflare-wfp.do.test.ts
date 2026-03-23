import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  migrateMock,
  createDurableHooksProcessorMock,
  createCloudflareServerMock,
  loadDurableHookQueueMock,
  resolveCloudflareDispatchNamespaceNameMock,
} = vi.hoisted(() => ({
  migrateMock: vi.fn(async () => undefined),
  createDurableHooksProcessorMock: vi.fn(),
  createCloudflareServerMock: vi.fn(),
  loadDurableHookQueueMock: vi.fn(),
  resolveCloudflareDispatchNamespaceNameMock: vi.fn(() => "staging"),
}));

vi.mock("cloudflare:workers", () => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  return { DurableObject: MockDurableObject };
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

vi.mock("@/fragno/durable-hooks", () => ({
  loadDurableHookQueue: loadDurableHookQueueMock,
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

  return { storage } as unknown as DurableObjectState;
};

describe("CloudflareWorkers Durable Object", () => {
  beforeEach(() => {
    migrateMock.mockClear();
    createDurableHooksProcessorMock.mockReset();
    createCloudflareServerMock.mockReset();
    loadDurableHookQueueMock.mockReset();
    resolveCloudflareDispatchNamespaceNameMock.mockClear();
  });

  test("stores the first org id once and rejects rebinding to another org", async () => {
    const state = createState();
    const workers = new CloudflareWorkers(state, {} as CloudflareEnv);

    await expect(workers.getHookQueue({ orgId: "  acme  " })).resolves.toEqual(EMPTY_QUEUE);

    expect(state.storage.put).toHaveBeenCalledTimes(1);
    expect(state.storage.put).toHaveBeenCalledWith(CONFIG_KEY, { orgId: "acme" });

    await expect(workers.getHookQueue({ orgId: "other-org" })).rejects.toThrowError(
      'Cloudflare Workers Durable Object is already bound to organisation "acme".',
    );

    expect(state.storage.put).toHaveBeenCalledTimes(1);
  });

  test("accepts the same stored org id without rewriting storage", async () => {
    const state = createState({ [CONFIG_KEY]: { orgId: "acme" } });
    const workers = new CloudflareWorkers(state, {} as CloudflareEnv);

    await expect(workers.getHookQueue({ orgId: " acme " })).resolves.toEqual(EMPTY_QUEUE);

    expect(state.storage.get).toHaveBeenCalledWith(CONFIG_KEY);
    expect(state.storage.put).not.toHaveBeenCalled();
  });

  test("rejects a different org id when one is already stored", async () => {
    const state = createState({ [CONFIG_KEY]: { orgId: "acme" } });
    const workers = new CloudflareWorkers(state, {} as CloudflareEnv);

    await expect(workers.getHookQueue({ orgId: "other-org" })).rejects.toThrowError(
      'Cloudflare Workers Durable Object is already bound to organisation "acme".',
    );

    expect(state.storage.get).toHaveBeenCalledWith(CONFIG_KEY);
    expect(state.storage.put).not.toHaveBeenCalled();
  });
});
