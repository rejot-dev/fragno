import { afterEach, describe, expect, it, vi, assert } from "vitest";

import { DurableHooksLogger } from "../../hooks/durable-hooks-logger";
import { createDurableHooksDispatcherDurableObject } from "./dispatcher";

const flushAlarmScheduling = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const completedRun = (count = 0) => ({
  claimedCount: count,
  completion: Promise.resolve(count),
});

describe("createDurableHooksDispatcherDurableObject", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("should schedule an initial alarm on creation", async () => {
    const processDue = vi.fn().mockResolvedValue(completedRun());
    const getNextWakeAt = vi.fn().mockResolvedValue(new Date());
    const drain = vi.fn().mockResolvedValue(undefined);
    const setAlarm = vi.fn().mockResolvedValue(undefined);

    const handlerFactory = createDurableHooksDispatcherDurableObject({
      createProcessor: () => ({
        processDue,
        getNextWakeAt,
        drain,
        namespace: "test",
      }),
    });

    handlerFactory({ storage: { setAlarm } }, {});

    await flushAlarmScheduling();
    expect(setAlarm).toHaveBeenCalledTimes(1);
    expect(processDue).not.toHaveBeenCalled();
  });

  it("should expose hook draining to in-memory runtimes", async () => {
    const drain = vi.fn().mockResolvedValue(undefined);
    const setBackgroundDrain = vi.fn();
    const handlerFactory = createDurableHooksDispatcherDurableObject({
      createProcessor: () => ({
        processDue: vi.fn().mockResolvedValue(completedRun()),
        getNextWakeAt: vi.fn().mockResolvedValue(null),
        drain,
        namespace: "test",
      }),
    });

    const handler = handlerFactory(
      { storage: { setAlarm: vi.fn().mockResolvedValue(undefined) }, setBackgroundDrain },
      {},
    );

    expect(setBackgroundDrain).toHaveBeenCalledTimes(1);
    const [backgroundDrain] = setBackgroundDrain.mock.calls[0] as [() => Promise<void>];
    await backgroundDrain();
    await handler.drain?.();

    expect(drain).toHaveBeenCalledTimes(2);
  });

  it("should leave the alarm unchanged when no pending hooks exist", async () => {
    const processDue = vi.fn().mockResolvedValue(completedRun());
    const getNextWakeAt = vi.fn().mockResolvedValue(null);
    const drain = vi.fn().mockResolvedValue(undefined);
    const setAlarm = vi.fn().mockResolvedValue(undefined);

    const handlerFactory = createDurableHooksDispatcherDurableObject({
      createProcessor: () => ({
        processDue,
        getNextWakeAt,
        drain,
        namespace: "test",
      }),
    });

    const handler = handlerFactory({ storage: { setAlarm } }, {});

    await flushAlarmScheduling();
    expect(getNextWakeAt).toHaveBeenCalledTimes(1);

    await handler.alarm?.();

    expect(processDue).toHaveBeenCalledTimes(1);
    expect(setAlarm).not.toHaveBeenCalled();
  });

  it("should schedule alarm on notify and forward promise to waitUntil", async () => {
    const processDue = vi.fn().mockResolvedValue(completedRun());
    const getNextWakeAt = vi.fn().mockResolvedValue(new Date("2024-01-01T00:00:00Z"));
    const drain = vi.fn().mockResolvedValue(undefined);
    const setAlarm = vi.fn().mockResolvedValue(undefined);

    const handlerFactory = createDurableHooksDispatcherDurableObject({
      createProcessor: () => ({
        processDue,
        getNextWakeAt,
        drain,
        namespace: "test",
      }),
    });

    const handler = handlerFactory({ storage: { setAlarm } }, {});
    await flushAlarmScheduling();
    expect(setAlarm).toHaveBeenCalledTimes(1);

    const waitUntil = vi.fn();
    await handler.notify?.({ source: "request", waitUntil });

    expect(waitUntil).toHaveBeenCalledTimes(1);
    const [notifyPromise] = waitUntil.mock.calls[0] as [Promise<void>];
    await notifyPromise;

    expect(processDue).not.toHaveBeenCalled();
    expect(setAlarm).toHaveBeenCalledTimes(2);
  });

  it("should not postpone an existing due alarm", async () => {
    vi.useFakeTimers();
    const now = new Date("2024-01-01T00:00:00Z");
    vi.setSystemTime(now);

    const processDue = vi.fn().mockResolvedValue(completedRun());
    const getNextWakeAt = vi.fn().mockResolvedValue(new Date(now.getTime() + 60000));
    const drain = vi.fn().mockResolvedValue(undefined);
    const getAlarm = vi.fn().mockResolvedValue(now.getTime() - 1);
    const setAlarm = vi.fn().mockResolvedValue(undefined);

    const handlerFactory = createDurableHooksDispatcherDurableObject({
      createProcessor: () => ({
        processDue,
        getNextWakeAt,
        drain,
        namespace: "test",
      }),
    });

    handlerFactory({ storage: { getAlarm, setAlarm } }, {});

    await flushAlarmScheduling();
    expect(getAlarm).toHaveBeenCalledTimes(1);
    expect(setAlarm).not.toHaveBeenCalled();
  });

  it("should start another alarm run while an earlier run is completing", async () => {
    const firstCompletion = Promise.withResolvers<number>();
    const processDue = vi
      .fn()
      .mockResolvedValueOnce({
        claimedCount: 1,
        completion: firstCompletion.promise,
      })
      .mockResolvedValueOnce(completedRun(1));
    const getNextWakeAt = vi.fn().mockResolvedValue(null);
    const drain = vi.fn().mockResolvedValue(undefined);
    const setAlarm = vi.fn().mockResolvedValue(undefined);

    const handlerFactory = createDurableHooksDispatcherDurableObject({
      createProcessor: () => ({
        processDue,
        getNextWakeAt,
        drain,
        namespace: "test",
      }),
    });

    const handler = handlerFactory({ storage: { setAlarm } }, {});
    await flushAlarmScheduling();

    await handler.alarm?.();
    await handler.alarm?.();

    expect(processDue).toHaveBeenCalledTimes(2);

    firstCompletion.resolve(1);
    await firstCompletion.promise;
    await flushAlarmScheduling();
  });

  it("should delete the processing-timeout alarm after the last hook completes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    const completion = Promise.withResolvers<number>();
    const wakeAt = new Date("2024-01-01T00:10:00Z");
    const processDue = vi.fn().mockResolvedValue({
      claimedCount: 1,
      completion: completion.promise,
    });
    const getNextWakeAt = vi
      .fn()
      .mockResolvedValueOnce(wakeAt)
      .mockResolvedValueOnce(wakeAt)
      .mockResolvedValueOnce(null);
    const drain = vi.fn().mockResolvedValue(undefined);
    let alarmTimestamp: number | null = null;
    const getAlarm = vi.fn(async () => alarmTimestamp);
    const setAlarm = vi.fn(async (timestamp: number | Date) => {
      alarmTimestamp = timestamp instanceof Date ? timestamp.getTime() : timestamp;
    });
    const deleteAlarm = vi.fn(async () => {
      alarmTimestamp = null;
    });

    const handlerFactory = createDurableHooksDispatcherDurableObject({
      createProcessor: () => ({
        processDue,
        getNextWakeAt,
        drain,
        namespace: "test",
      }),
    });
    const handler = handlerFactory({ storage: { getAlarm, setAlarm, deleteAlarm } }, {});
    await flushAlarmScheduling();
    assert(alarmTimestamp === wakeAt.getTime());

    await handler.alarm?.();
    assert(alarmTimestamp === wakeAt.getTime());

    completion.resolve(1);
    await completion.promise;
    await flushAlarmScheduling();

    expect(deleteAlarm).toHaveBeenCalledTimes(1);
    assert(alarmTimestamp === null);
  });

  it("should not delete an alarm that was not scheduled by the hook dispatcher", async () => {
    const existingAlarm = new Date("2024-01-01T00:10:00Z").getTime();
    const deleteAlarm = vi.fn().mockResolvedValue(undefined);
    const handlerFactory = createDurableHooksDispatcherDurableObject({
      createProcessor: () => ({
        processDue: vi.fn().mockResolvedValue(completedRun()),
        getNextWakeAt: vi.fn().mockResolvedValue(null),
        drain: vi.fn().mockResolvedValue(undefined),
        namespace: "test",
      }),
    });

    handlerFactory(
      {
        storage: {
          getAlarm: vi.fn().mockResolvedValue(existingAlarm),
          setAlarm: vi.fn().mockResolvedValue(undefined),
          deleteAlarm,
        },
      },
      {},
    );
    await flushAlarmScheduling();

    expect(deleteAlarm).not.toHaveBeenCalled();
  });

  it("should schedule alarm using max(nextWakeAt, now)", async () => {
    vi.useFakeTimers();
    const now = new Date("2024-01-01T00:00:00Z");
    vi.setSystemTime(now);

    const processDue = vi.fn().mockResolvedValue(completedRun());
    const getNextWakeAt = vi.fn().mockResolvedValue(new Date(now.getTime() - 10000));
    const drain = vi.fn().mockResolvedValue(undefined);
    const setAlarm = vi.fn().mockResolvedValue(undefined);

    const handlerFactory = createDurableHooksDispatcherDurableObject({
      createProcessor: () => ({
        processDue,
        getNextWakeAt,
        drain,
        namespace: "test",
      }),
    });

    const handler = handlerFactory({ storage: { setAlarm } }, {});

    await flushAlarmScheduling();
    expect(setAlarm).toHaveBeenCalledTimes(1);

    await handler.alarm?.();

    expect(setAlarm.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const [scheduledAt] of setAlarm.mock.calls) {
      expect(scheduledAt.getTime()).toBeGreaterThanOrEqual(now.getTime());
    }
    vi.useRealTimers();
  });

  it("should recover alarm processing when onProcessError throws", async () => {
    const processFailure = new Error("process failed");
    const processDue = vi
      .fn()
      .mockRejectedValueOnce(processFailure)
      .mockResolvedValueOnce(completedRun());
    const getNextWakeAt = vi.fn().mockResolvedValue(new Date("2024-01-01T00:00:00Z"));
    const drain = vi.fn().mockResolvedValue(undefined);
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const onProcessError = vi.fn(() => {
      throw new Error("callback failed");
    });
    const errorSpy = vi.spyOn(DurableHooksLogger, "error").mockImplementation(() => {});

    const handlerFactory = createDurableHooksDispatcherDurableObject({
      createProcessor: () => ({
        processDue,
        getNextWakeAt,
        drain,
        namespace: "test",
      }),
      onProcessError,
    });

    const handler = handlerFactory({ storage: { setAlarm } }, {});
    await flushAlarmScheduling();

    await handler.alarm?.();
    await handler.alarm?.();
    await Promise.resolve();

    expect(processDue).toHaveBeenCalledTimes(2);
    expect(onProcessError).toHaveBeenCalledWith(processFailure);
    assert(
      errorSpy.mock.calls.some(
        ([message]) => message === "Durable hooks dispatcher onProcessError callback failed",
      ),
    );
  });

  it("should resolve notify when onProcessError throws in schedule error path", async () => {
    const scheduleFailure = new Error("schedule failed");
    const processDue = vi.fn().mockResolvedValue(completedRun());
    const getNextWakeAt = vi
      .fn()
      .mockResolvedValueOnce(new Date("2024-01-01T00:00:00Z"))
      .mockRejectedValueOnce(scheduleFailure);
    const drain = vi.fn().mockResolvedValue(undefined);
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const onProcessError = vi.fn(() => {
      throw new Error("callback failed");
    });
    const errorSpy = vi.spyOn(DurableHooksLogger, "error").mockImplementation(() => {});

    const handlerFactory = createDurableHooksDispatcherDurableObject({
      createProcessor: () => ({
        processDue,
        getNextWakeAt,
        drain,
        namespace: "test",
      }),
      onProcessError,
    });

    const handler = handlerFactory({ storage: { setAlarm } }, {});
    await flushAlarmScheduling();

    await handler.notify?.({ source: "request" });
    await Promise.resolve();

    expect(onProcessError).toHaveBeenCalledWith(scheduleFailure);
    assert(
      errorSpy.mock.calls.some(
        ([message]) => message === "Durable hooks dispatcher onProcessError callback failed",
      ),
    );
  });
});
