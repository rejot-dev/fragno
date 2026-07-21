import { describe, expect, it, vi } from "vitest";

import { StreamStatusController } from "./stream-status";

describe("StreamStatusController", () => {
  it("resolves readiness and waits for later ready offsets", async () => {
    const status = new StreamStatusController();
    const ready = status.waitUntilReady();

    status.beginSynchronization();
    status.markReady("0000000000000000000000001");
    await expect(ready).resolves.toBeUndefined();

    const advanced = status.waitUntilReadyAfterOffset("0000000000000000000000001");
    status.markLoading("0000000000000000000000002");
    status.markReady("0000000000000000000000002");
    await expect(advanced).resolves.toBeUndefined();
  });

  it("rejects current and future readiness after a terminal error", async () => {
    const status = new StreamStatusController();
    const error = new Error("terminal");
    const waiting = status.waitUntilReady();

    expect(status.markError(error)).toEqual({ error, enteredError: true });
    await expect(waiting).rejects.toBe(error);
    await expect(status.waitUntilReady()).rejects.toBe(error);
    expect(status.markError(new Error("later"))).toEqual({ error, enteredError: false });
  });

  it("notifies subscribers of state transitions", () => {
    const status = new StreamStatusController();
    const listener = vi.fn();
    const unsubscribe = status.subscribe(listener);

    status.beginSynchronization();
    status.markReady("0000000000000000000000001");
    unsubscribe();
    status.markClosed();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1]?.[0]).toEqual({
      status: "ready",
      offset: "0000000000000000000000001",
      error: null,
    });
  });
});
