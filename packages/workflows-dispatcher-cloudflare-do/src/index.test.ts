import { describe, expect, it, vi } from "vitest";
import { createDurableHooksDispatcherDurableObject } from "./index";

describe("createDurableHooksDispatcherDurableObject (shim)", () => {
  it("schedules alarms based on next wake time", async () => {
    const process = vi.fn().mockResolvedValue(0);
    const getNextWakeAt = vi.fn().mockResolvedValue(new Date("2024-01-01T00:00:00Z"));
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const deleteAlarm = vi.fn().mockResolvedValue(undefined);

    const handlerFactory = createDurableHooksDispatcherDurableObject({
      createProcessor: () => ({ process, getNextWakeAt, namespace: "test" }),
    });

    const handler = handlerFactory({ storage: { setAlarm, deleteAlarm } }, {});

    await vi.waitFor(() => expect(setAlarm).toHaveBeenCalledTimes(1));

    await handler.alarm?.();

    expect(process).toHaveBeenCalledTimes(1);
    expect(setAlarm).toHaveBeenCalledTimes(2);
    expect(deleteAlarm).not.toHaveBeenCalled();
  });
});
