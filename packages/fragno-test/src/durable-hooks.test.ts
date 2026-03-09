import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDurableHooksProcessor } from "@fragno-dev/db/dispatchers/node";

import { drainDurableHooks } from "./durable-hooks";

const drainMock = vi.fn<() => Promise<void>>();
const wakeMock = vi.fn<() => Promise<void>>();

vi.mock("@fragno-dev/db/dispatchers/node", () => ({
  createDurableHooksProcessor: vi.fn(() => ({
    drain: drainMock,
    wake: wakeMock,
  })),
}));

describe("drainDurableHooks", () => {
  beforeEach(() => {
    drainMock.mockReset();
    wakeMock.mockReset();
    vi.mocked(createDurableHooksProcessor).mockClear();
  });

  it("no-ops when durable hooks are not configured", async () => {
    await expect(
      drainDurableHooks({
        $internal: {},
      } as never),
    ).resolves.toBeUndefined();

    expect(createDurableHooksProcessor).not.toHaveBeenCalled();
    expect(drainMock).not.toHaveBeenCalled();
    expect(wakeMock).not.toHaveBeenCalled();
  });

  it("drains until idle by default", async () => {
    await drainDurableHooks({
      $internal: { durableHooksToken: {} },
    } as never);

    expect(createDurableHooksProcessor).toHaveBeenCalledTimes(1);
    expect(wakeMock).not.toHaveBeenCalled();
    expect(drainMock).toHaveBeenCalledTimes(1);
  });

  it("supports single-pass draining", async () => {
    await drainDurableHooks(
      {
        $internal: { durableHooksToken: {} },
      } as never,
      { mode: "singlePass" },
    );

    expect(createDurableHooksProcessor).toHaveBeenCalledTimes(1);
    expect(wakeMock).toHaveBeenCalledTimes(1);
    expect(drainMock).not.toHaveBeenCalled();
  });
});
