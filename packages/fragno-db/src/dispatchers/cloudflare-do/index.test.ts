import { describe, expect, it, vi } from "vitest";
import { createDurableHooksDispatcherDurableObject } from "./index";

describe("createDurableHooksDispatcherDurableObject", () => {
  it("should schedule an initial alarm on creation", async () => {
    const process = vi.fn().mockResolvedValue(0);
    const getNextWakeAt = vi.fn().mockResolvedValue(new Date());
    const setAlarm = vi.fn().mockResolvedValue(undefined);

    const handlerFactory = createDurableHooksDispatcherDurableObject({
      createProcessor: () => ({ process, getNextWakeAt, namespace: "test" }),
    });

    handlerFactory({ storage: { setAlarm } }, {});

    await Promise.resolve();
    expect(setAlarm).toHaveBeenCalledTimes(1);
    expect(process).not.toHaveBeenCalled();
  });

  it("should delete the alarm when no pending hooks exist", async () => {
    const process = vi.fn().mockResolvedValue(0);
    const getNextWakeAt = vi.fn().mockResolvedValue(null);
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const deleteAlarm = vi.fn().mockResolvedValue(undefined);

    const handlerFactory = createDurableHooksDispatcherDurableObject({
      createProcessor: () => ({ process, getNextWakeAt, namespace: "test" }),
    });

    const handler = handlerFactory({ storage: { setAlarm, deleteAlarm } }, {});

    await Promise.resolve();
    expect(getNextWakeAt).toHaveBeenCalledTimes(1);

    await handler.alarm?.();

    expect(process).toHaveBeenCalledTimes(1);
    expect(deleteAlarm).toHaveBeenCalledTimes(2);
    expect(setAlarm).not.toHaveBeenCalled();
  });

  it("should schedule alarm using max(nextWakeAt, now)", async () => {
    vi.useFakeTimers();
    const now = new Date("2024-01-01T00:00:00Z");
    vi.setSystemTime(now);

    const process = vi.fn().mockResolvedValue(0);
    const getNextWakeAt = vi.fn().mockResolvedValue(new Date(now.getTime() - 10000));
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const deleteAlarm = vi.fn().mockResolvedValue(undefined);

    const handlerFactory = createDurableHooksDispatcherDurableObject({
      createProcessor: () => ({ process, getNextWakeAt, namespace: "test" }),
    });

    const handler = handlerFactory({ storage: { setAlarm, deleteAlarm } }, {});

    await Promise.resolve();
    expect(setAlarm).toHaveBeenCalledTimes(1);

    await handler.alarm?.();

    expect(setAlarm).toHaveBeenCalledTimes(2);
    for (const [scheduledAt] of setAlarm.mock.calls) {
      expect(scheduledAt.getTime()).toBeGreaterThanOrEqual(now.getTime());
    }
    vi.useRealTimers();
  });
});
