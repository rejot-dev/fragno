import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  migrateMock,
  createDurableHooksProcessorMock,
  createAuthServerMock,
  loadDurableHookQueueMock,
  handlerMock,
  dispatcherAlarmMock,
} = vi.hoisted(() => ({
  migrateMock: vi.fn(async () => undefined),
  createDurableHooksProcessorMock: vi.fn(),
  createAuthServerMock: vi.fn(),
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

vi.mock("@/fragno/auth", () => ({
  createAuthServer: createAuthServerMock,
}));

vi.mock("@/fragno/durable-hooks", () => ({
  loadDurableHookQueue: loadDurableHookQueueMock,
}));

import { Auth } from "./auth.do";

const createState = () =>
  ({
    blockConcurrencyWhile: vi.fn((callback: () => Promise<unknown>) => callback()),
    waitUntil: vi.fn(),
  }) as unknown as DurableObjectState;

describe("Auth Durable Object", () => {
  beforeEach(() => {
    migrateMock.mockClear();
    createDurableHooksProcessorMock.mockReset();
    createAuthServerMock.mockReset();
    loadDurableHookQueueMock.mockReset();
    handlerMock.mockClear();
    dispatcherAlarmMock.mockReset();

    createDurableHooksProcessorMock.mockImplementation(() => {
      return () => ({
        alarm: dispatcherAlarmMock,
      });
    });

    createAuthServerMock.mockImplementation(() => ({
      handler: handlerMock,
    }));
  });

  test("uses a validated forwarded proto while ignoring the forwarded host", async () => {
    const state = createState();
    const auth = new Auth(state, {} as CloudflareEnv);

    const response = await auth.fetch(
      new Request("http://docs.example/api/auth/login", {
        headers: {
          "x-forwarded-host": "evil.example",
          "x-forwarded-proto": "https",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(createAuthServerMock).toHaveBeenLastCalledWith(
      { type: "live", env: {}, state },
      { baseUrl: "https://docs.example" },
    );
    expect(createAuthServerMock).not.toHaveBeenCalledWith(expect.anything(), {
      baseUrl: "https://evil.example",
    });
  });

  test("ignores invalid forwarded proto values", async () => {
    const state = createState();
    const auth = new Auth(state, {} as CloudflareEnv);

    const response = await auth.fetch(
      new Request("https://docs.example/api/auth/login", {
        headers: {
          "x-forwarded-proto": "javascript",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(createAuthServerMock).toHaveBeenLastCalledWith(
      { type: "live", env: {}, state },
      { baseUrl: "https://docs.example" },
    );
  });
});
