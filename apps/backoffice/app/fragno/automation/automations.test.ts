import { beforeEach, describe, expect, test, vi } from "vitest";

const { createDurableHooksProcessorMock } = vi.hoisted(() => ({
  createDurableHooksProcessorMock: vi.fn(),
}));

vi.mock("@fragno-dev/db/dispatchers/cloudflare-do", () => ({
  createDurableHooksProcessor: createDurableHooksProcessorMock,
}));

import { createAutomationsDispatcher } from "./automations";

describe("createAutomationsDispatcher", () => {
  beforeEach(() => {
    createDurableHooksProcessorMock.mockReset();
  });

  test("returns the durable hooks dispatcher when initialization succeeds", () => {
    const dispatcher = {
      notify: vi.fn(async () => undefined),
      alarm: vi.fn(async () => undefined),
    };

    createDurableHooksProcessorMock.mockReturnValue(() => dispatcher);

    expect(
      createAutomationsDispatcher(
        {} as never,
        {} as never,
        {} as DurableObjectState,
        {} as CloudflareEnv,
      ),
    ).toBe(dispatcher);
  });

  test("rethrows dispatcher initialization failures instead of disabling processing", () => {
    createDurableHooksProcessorMock.mockReturnValue(() => {
      throw new Error("dispatcher init failed");
    });

    expect(() =>
      createAutomationsDispatcher(
        {} as never,
        {} as never,
        {} as DurableObjectState,
        {} as CloudflareEnv,
      ),
    ).toThrowError("dispatcher init failed");
  });
});
