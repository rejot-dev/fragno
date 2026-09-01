import { afterEach, describe, expect, it, vi, assert } from "vitest";

import { DurableHooksLogger } from "../../hooks/durable-hooks-logger";
import { createDurableHooksDispatcherDurableObject } from "./dispatcher";

const completedRun = (count = 0) => ({
  claimedCount: count,
  completion: Promise.resolve(count),
});

describe("createDurableHooksDispatcherDurableObject", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("should schedule an initial alarm during explicit initialization", async () => {
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

    const handler = handlerFactory({ storage: { setAlarm } }, {});

    await handler.initialize?.();
    expect(setAlarm).toHaveBeenCalledTimes(1);
    expect(processDue).not.toHaveBeenCalled();
  });

  it("should reject initialization when the initial alarm cannot be scheduled", async () => {
    const scheduleFailure = new Error("initial alarm unavailable");
    const onProcessError = vi.fn().mockResolvedValue(undefined);
    const handlerFactory = createDurableHooksDispatcherDurableObject({
      createProcessor: () => ({
        processDue: vi.fn().mockResolvedValue(completedRun()),
        getNextWakeAt: vi.fn().mockResolvedValue(new Date()),
        drain: vi.fn().mockResolvedValue(undefined),
        namespace: "test",
      }),
      onProcessError,
    });
    const handler = handlerFactory(
      { storage: { setAlarm: vi.fn().mockRejectedValue(scheduleFailure) } },
      {},
    );

    await expect(handler.initialize?.()).rejects.toBe(scheduleFailure);
    expect(onProcessError).toHaveBeenCalledWith(scheduleFailure);
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

    await handler.initialize?.();
    expect(getNextWakeAt).toHaveBeenCalledTimes(1);

    await handler.alarm?.();

    expect(processDue).toHaveBeenCalledTimes(1);
    expect(setAlarm).not.toHaveBeenCalled();
  });

  it("should resolve notify only after alarm scheduling completes", async () => {
    const processDue = vi.fn().mockResolvedValue(completedRun());
    const getNextWakeAt = vi.fn().mockResolvedValue(new Date("2024-01-01T00:00:00Z"));
    const drain = vi.fn().mockResolvedValue(undefined);
    const notifyAlarmScheduling = Promise.withResolvers<void>();
    const setAlarm = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => await notifyAlarmScheduling.promise);

    const handlerFactory = createDurableHooksDispatcherDurableObject({
      createProcessor: () => ({
        processDue,
        getNextWakeAt,
        drain,
        namespace: "test",
      }),
    });

    const handler = handlerFactory({ storage: { setAlarm } }, {});
    await handler.initialize?.();
    expect(setAlarm).toHaveBeenCalledTimes(1);

    const notification = handler.notify?.({ source: "request" });
    assert(notification);
    let notificationCompleted = false;
    const notificationCompletion = notification.then(() => {
      notificationCompleted = true;
    });

    await vi.waitFor(() => expect(setAlarm).toHaveBeenCalledTimes(2));
    assert(!notificationCompleted);
    expect(processDue).not.toHaveBeenCalled();

    notifyAlarmScheduling.resolve();
    await notificationCompletion;
    assert(notificationCompleted);
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

    const handler = handlerFactory({ storage: { getAlarm, setAlarm } }, {});

    await handler.initialize?.();
    expect(getAlarm).toHaveBeenCalledTimes(1);
    expect(setAlarm).not.toHaveBeenCalled();
  });

  it("should serialize concurrent alarms behind active hook completion", async () => {
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
    await handler.initialize?.();

    const firstAlarm = handler.alarm?.();
    assert(firstAlarm);
    await vi.waitFor(() => expect(processDue).toHaveBeenCalledTimes(1));
    const secondAlarm = handler.alarm?.();
    assert(secondAlarm);
    await Promise.resolve();
    expect(processDue).toHaveBeenCalledTimes(1);

    firstCompletion.resolve(1);
    await Promise.all([firstAlarm, secondAlarm]);
    expect(processDue).toHaveBeenCalledTimes(2);
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
    const getNextWakeAt = vi.fn().mockResolvedValueOnce(wakeAt).mockResolvedValueOnce(null);
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
    await handler.initialize?.();
    assert(alarmTimestamp === wakeAt.getTime());

    const alarm = handler.alarm?.();
    assert(alarm);
    await vi.waitFor(() => expect(processDue).toHaveBeenCalledTimes(1));
    assert(alarmTimestamp === wakeAt.getTime());

    completion.resolve(1);
    await alarm;

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

    const handler = handlerFactory(
      {
        storage: {
          getAlarm: vi.fn().mockResolvedValue(existingAlarm),
          setAlarm: vi.fn().mockResolvedValue(undefined),
          deleteAlarm,
        },
      },
      {},
    );
    await handler.initialize?.();

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

    await handler.initialize?.();
    expect(setAlarm).toHaveBeenCalledTimes(1);

    await handler.alarm?.();

    expect(setAlarm.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const [scheduledAt] of setAlarm.mock.calls) {
      expect(scheduledAt.getTime()).toBeGreaterThanOrEqual(now.getTime());
    }
    vi.useRealTimers();
  });

  it("should await async process error reporting before completing the alarm", async () => {
    const processFailure = new Error("process failed");
    const errorReporting = Promise.withResolvers<void>();
    const processDue = vi.fn().mockRejectedValue(processFailure);
    const getNextWakeAt = vi.fn().mockResolvedValue(null);
    const onProcessError = vi.fn(async () => await errorReporting.promise);

    const handlerFactory = createDurableHooksDispatcherDurableObject({
      createProcessor: () => ({
        processDue,
        getNextWakeAt,
        drain: vi.fn().mockResolvedValue(undefined),
        namespace: "test",
      }),
      onProcessError,
    });

    const handler = handlerFactory(
      { storage: { setAlarm: vi.fn().mockResolvedValue(undefined) } },
      {},
    );
    await handler.initialize?.();

    let alarmCompleted = false;
    const alarm = handler.alarm?.().then(() => {
      alarmCompleted = true;
    });
    assert(alarm);
    await vi.waitFor(() => expect(onProcessError).toHaveBeenCalledWith(processFailure));
    assert(!alarmCompleted);

    errorReporting.resolve();
    await alarm;
    assert(alarmCompleted);
  });

  it("should recover alarm processing when async onProcessError rejects", async () => {
    const processFailure = new Error("process failed");
    const processDue = vi
      .fn()
      .mockRejectedValueOnce(processFailure)
      .mockResolvedValueOnce(completedRun());
    const getNextWakeAt = vi.fn().mockResolvedValue(new Date("2024-01-01T00:00:00Z"));
    const drain = vi.fn().mockResolvedValue(undefined);
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const onProcessError = vi.fn(async () => {
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
    await handler.initialize?.();

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

  it("should reject notify when alarm scheduling fails", async () => {
    const scheduleFailure = new Error("schedule failed");
    const processDue = vi.fn().mockResolvedValue(completedRun());
    const getNextWakeAt = vi
      .fn()
      .mockResolvedValueOnce(new Date("2024-01-01T00:00:00Z"))
      .mockRejectedValueOnce(scheduleFailure);
    const drain = vi.fn().mockResolvedValue(undefined);
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const onProcessError = vi.fn(async () => {
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
    await handler.initialize?.();

    await expect(handler.notify?.({ source: "request" })).rejects.toBe(scheduleFailure);

    expect(onProcessError).toHaveBeenCalledWith(scheduleFailure);
    assert(
      errorSpy.mock.calls.some(
        ([message]) => message === "Durable hooks dispatcher onProcessError callback failed",
      ),
    );
  });
});
