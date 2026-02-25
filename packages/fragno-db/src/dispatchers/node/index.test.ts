import { describe, expect, it, vi } from "vitest";
import { createDurableHooksDispatcher } from "./dispatcher";

describe("createDurableHooksDispatcher", () => {
  it("should wake and process hooks", async () => {
    const process = vi.fn().mockResolvedValue(0);
    const getNextWakeAt = vi.fn().mockResolvedValue(null);
    const drain = vi.fn().mockResolvedValue(undefined);

    const dispatcher = createDurableHooksDispatcher({
      processor: { process, getNextWakeAt, drain, namespace: "test" },
    });

    await dispatcher.wake();

    expect(process).toHaveBeenCalledTimes(1);
  });

  it("should coalesce overlapping wake calls", async () => {
    let resolveFirst!: (value: number) => void;
    const firstPromise = new Promise<number>((resolve) => {
      resolveFirst = resolve;
    });
    const process = vi.fn().mockReturnValueOnce(firstPromise).mockResolvedValue(0);
    const drain = vi.fn().mockResolvedValue(undefined);

    const dispatcher = createDurableHooksDispatcher({
      processor: {
        process,
        getNextWakeAt: vi.fn().mockResolvedValue(null),
        drain,
        namespace: "test",
      },
    });

    const first = dispatcher.wake();
    const second = dispatcher.wake();

    expect(process).toHaveBeenCalledTimes(1);

    resolveFirst(0);
    await first;
    await second;

    expect(process).toHaveBeenCalledTimes(2);
  });

  it("should poll and process when due", async () => {
    vi.useFakeTimers();
    const now = new Date("2024-01-01T00:00:00Z");
    vi.setSystemTime(now);

    const process = vi.fn().mockResolvedValue(0);
    const getNextWakeAt = vi.fn().mockResolvedValue(new Date(now.getTime() - 1000));
    const drain = vi.fn().mockResolvedValue(undefined);

    const dispatcher = createDurableHooksDispatcher({
      processor: { process, getNextWakeAt, drain, namespace: "test" },
      pollIntervalMs: 1000,
    });

    dispatcher.startPolling();
    await vi.advanceTimersByTimeAsync(1000);
    dispatcher.stopPolling();

    expect(process).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("should skip polling when next wake is in the future", async () => {
    vi.useFakeTimers();
    const now = new Date("2024-01-01T00:00:00Z");
    vi.setSystemTime(now);

    const process = vi.fn().mockResolvedValue(0);
    const getNextWakeAt = vi.fn().mockResolvedValue(new Date(now.getTime() + 60000));
    const drain = vi.fn().mockResolvedValue(undefined);

    const dispatcher = createDurableHooksDispatcher({
      processor: { process, getNextWakeAt, drain, namespace: "test" },
      pollIntervalMs: 1000,
    });

    dispatcher.startPolling();
    await vi.advanceTimersByTimeAsync(1000);
    dispatcher.stopPolling();

    expect(process).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
