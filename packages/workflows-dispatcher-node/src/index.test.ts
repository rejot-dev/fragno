import { describe, expect, it, vi } from "vitest";
import { createInProcessDispatcher } from "./index";

describe("createInProcessDispatcher", () => {
  it("polls and stops polling", async () => {
    vi.useFakeTimers();
    try {
      const wake = vi.fn();
      const dispatcher = createInProcessDispatcher({ wake, pollIntervalMs: 10 });

      dispatcher.startPolling();
      await vi.advanceTimersByTimeAsync(25);

      expect(wake).toHaveBeenCalled();

      dispatcher.stopPolling();
      wake.mockClear();

      await vi.advanceTimersByTimeAsync(25);
      expect(wake).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
