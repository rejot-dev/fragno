import { describe, expect, it, vi } from "vitest";
import { createAiDispatcherNode } from "./index";

describe("createAiDispatcherNode", () => {
  it("forwards wake to runner tick", async () => {
    const tick = vi.fn();
    const dispatcher = createAiDispatcherNode({
      runner: { tick },
      tickOptions: { maxRuns: 2 },
    });

    await dispatcher.wake({ type: "run.queued", runId: "run-1" });

    expect(tick).toHaveBeenCalledWith({ maxRuns: 2 });
  });

  it("polls and stops polling", async () => {
    vi.useFakeTimers();
    try {
      const tick = vi.fn();
      const dispatcher = createAiDispatcherNode({
        runner: { tick },
        pollIntervalMs: 10,
      });

      dispatcher.startPolling();
      await vi.advanceTimersByTimeAsync(25);

      expect(tick).toHaveBeenCalled();

      dispatcher.stopPolling();
      tick.mockClear();

      await vi.advanceTimersByTimeAsync(25);
      expect(tick).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
