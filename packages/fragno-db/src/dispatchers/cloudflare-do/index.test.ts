import { describe, expect, it, vi } from "vitest";
import { createDurableHooksDispatcherDurableObject } from "./dispatcher";

describe("createDurableHooksDispatcherDurableObject", () => {
  it("should schedule an initial alarm on creation", async () => {
    const processDue = vi.fn().mockResolvedValue(0);
    const getNextWakeAt = vi.fn().mockResolvedValue(new Date());
    const drain = vi.fn().mockResolvedValue(undefined);
    const setAlarm = vi.fn().mockResolvedValue(undefined);

    const handlerFactory = createDurableHooksDispatcherDurableObject({
      createProcessor: () => ({
        processDue,
        process: processDue,
        getNextWakeAt,
        drain,
        namespace: "test",
      }),
    });

    handlerFactory({ storage: { setAlarm } }, {});

    await Promise.resolve();
    expect(setAlarm).toHaveBeenCalledTimes(1);
    expect(processDue).not.toHaveBeenCalled();
  });

  it("should delete the alarm when no pending hooks exist", async () => {
    const processDue = vi.fn().mockResolvedValue(0);
    const getNextWakeAt = vi.fn().mockResolvedValue(null);
    const drain = vi.fn().mockResolvedValue(undefined);
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const deleteAlarm = vi.fn().mockResolvedValue(undefined);

    const handlerFactory = createDurableHooksDispatcherDurableObject({
      createProcessor: () => ({
        processDue,
        process: processDue,
        getNextWakeAt,
        drain,
        namespace: "test",
      }),
    });

    const handler = handlerFactory({ storage: { setAlarm, deleteAlarm } }, {});

    await Promise.resolve();
    expect(getNextWakeAt).toHaveBeenCalledTimes(1);

    await handler.alarm?.();

    expect(processDue).toHaveBeenCalledTimes(1);
    expect(deleteAlarm.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(setAlarm).not.toHaveBeenCalled();
  });

  it("should schedule alarm on notify and forward promise to waitUntil", async () => {
    const processDue = vi.fn().mockResolvedValue(0);
    const getNextWakeAt = vi.fn().mockResolvedValue(new Date("2024-01-01T00:00:00Z"));
    const drain = vi.fn().mockResolvedValue(undefined);
    const setAlarm = vi.fn().mockResolvedValue(undefined);

    const handlerFactory = createDurableHooksDispatcherDurableObject({
      createProcessor: () => ({
        processDue,
        process: processDue,
        getNextWakeAt,
        drain,
        namespace: "test",
      }),
    });

    const handler = handlerFactory({ storage: { setAlarm } }, {});
    await Promise.resolve();
    expect(setAlarm).toHaveBeenCalledTimes(1);

    const waitUntil = vi.fn();
    handler.notify?.({ source: "request", waitUntil });

    expect(waitUntil).toHaveBeenCalledTimes(1);
    const [notifyPromise] = waitUntil.mock.calls[0] as [Promise<void>];
    await notifyPromise;

    expect(processDue).not.toHaveBeenCalled();
    expect(setAlarm).toHaveBeenCalledTimes(2);
  });

  it("should schedule alarm using max(nextWakeAt, now)", async () => {
    vi.useFakeTimers();
    const now = new Date("2024-01-01T00:00:00Z");
    vi.setSystemTime(now);

    const processDue = vi.fn().mockResolvedValue(0);
    const getNextWakeAt = vi.fn().mockResolvedValue(new Date(now.getTime() - 10000));
    const drain = vi.fn().mockResolvedValue(undefined);
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const deleteAlarm = vi.fn().mockResolvedValue(undefined);

    const handlerFactory = createDurableHooksDispatcherDurableObject({
      createProcessor: () => ({
        processDue,
        process: processDue,
        getNextWakeAt,
        drain,
        namespace: "test",
      }),
    });

    const handler = handlerFactory({ storage: { setAlarm, deleteAlarm } }, {});

    await Promise.resolve();
    expect(setAlarm).toHaveBeenCalledTimes(1);

    await handler.alarm?.();

    expect(setAlarm.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const [scheduledAt] of setAlarm.mock.calls) {
      expect(scheduledAt.getTime()).toBeGreaterThanOrEqual(now.getTime());
    }
    vi.useRealTimers();
  });
});
