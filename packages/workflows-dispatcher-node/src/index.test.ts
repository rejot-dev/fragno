import { describe, expect, it, vi } from "vitest";
import { createDurableHooksDispatcher } from "./index";

describe("createDurableHooksDispatcher (shim)", () => {
  it("polls and stops polling", async () => {
    vi.useFakeTimers();
    try {
      const process = vi.fn().mockResolvedValue(0);
      const getNextWakeAt = vi.fn().mockResolvedValue(new Date(Date.now() - 1000));
      const dispatcher = createDurableHooksDispatcher({
        processor: { process, getNextWakeAt, namespace: "test" },
        pollIntervalMs: 10,
      });

      dispatcher.startPolling();
      await vi.advanceTimersByTimeAsync(25);

      expect(process).toHaveBeenCalled();

      dispatcher.stopPolling();
      process.mockClear();

      await vi.advanceTimersByTimeAsync(25);
      expect(process).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
