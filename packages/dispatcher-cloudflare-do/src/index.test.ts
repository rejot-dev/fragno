import { describe, expect, test, vi } from "vitest";
import { DispatcherDurableObjectRuntime, type DispatcherDurableObjectState } from "./index";

type AlarmCall = number;

type TestStateOptions = {
  alarmCalls: AlarmCall[];
};

const createState = ({ alarmCalls }: TestStateOptions): DispatcherDurableObjectState => {
  const storage = {
    transaction: async <T>(closure: (txn: { rollback(): void }) => Promise<T>) =>
      await closure({ rollback: () => {} }),
    setAlarm: async (timestamp: number | Date) => {
      const value = typeof timestamp === "number" ? timestamp : timestamp.getTime();
      alarmCalls.push(value);
    },
    deleteAlarm: async () => {
      alarmCalls.push(-1);
    },
    sql: {} as DispatcherDurableObjectState["storage"]["sql"],
  } as DispatcherDurableObjectState["storage"];

  return {
    id: {
      toString: () => "do-test",
      equals: (other: { toString(): string }) => other.toString() === "do-test",
    },
    storage,
  };
};

describe("dispatcher durable object runtime", () => {
  test("schedules an alarm after a tick", async () => {
    const alarmCalls: number[] = [];
    const tick = vi.fn(async (_options: number) => 1);
    const runtime = new DispatcherDurableObjectRuntime<number, number>({
      state: createState({ alarmCalls }),
      tick,
      tickOptions: 1,
      queuedResult: 0,
      getNextWakeAt: async () => new Date(Date.now() + 1000),
    });

    const result = await runtime.wake(1);

    expect(result).toBe(1);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(alarmCalls.length).toBe(1);
    expect(alarmCalls[0]).toBeGreaterThan(0);
  });

  test("clears alarms when no wake is pending", async () => {
    const alarmCalls: number[] = [];
    const tick = vi.fn(async (_options: number) => 2);
    const runtime = new DispatcherDurableObjectRuntime<number, number>({
      state: createState({ alarmCalls }),
      tick,
      tickOptions: 1,
      queuedResult: 0,
      getNextWakeAt: async () => null,
    });

    await runtime.wake(1);

    expect(alarmCalls).toEqual([-1]);
  });
});
