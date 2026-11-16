import { beforeEach, describe, expect, test, vi } from "vitest";

const { createDurableHooksProcessorMock } = vi.hoisted(() => ({
  createDurableHooksProcessorMock: vi.fn(),
}));

vi.mock("@fragno-dev/db/dispatchers/cloudflare-do", () => ({
  createDurableHooksProcessor: createDurableHooksProcessorMock,
}));

import { createAutomationsDispatcher } from "./automations";

const createInstrumentation = () => ({
  captureContext: vi.fn(() => null),
  runAttempt: vi.fn(async (_attempt, execute) => await execute()),
});

describe("createAutomationsDispatcher", () => {
  beforeEach(() => {
    createDurableHooksProcessorMock.mockReset();
  });

  test("returns the instrumented durable hooks dispatcher when initialization succeeds", () => {
    const instrumentation = createInstrumentation();
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
        instrumentation,
      ),
    ).toBe(dispatcher);
    expect(createDurableHooksProcessorMock).toHaveBeenCalledWith([{}, {}], {
      instrumentation,
      onProcessError: expect.any(Function),
    });
  });

  test("rethrows dispatcher initialization failures instead of disabling processing", () => {
    const instrumentation = createInstrumentation();
    createDurableHooksProcessorMock.mockReturnValue(() => {
      throw new Error("dispatcher init failed");
    });

    expect(() =>
      createAutomationsDispatcher(
        {} as never,
        {} as never,
        {} as DurableObjectState,
        {} as CloudflareEnv,
        instrumentation,
      ),
    ).toThrow("dispatcher init failed");
  });
});
