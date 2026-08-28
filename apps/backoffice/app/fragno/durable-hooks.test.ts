import { describe, expect, test, vi } from "vitest";

import { createDurableHookRepositoryFromCommands } from "@/fragno/durable-hook-command-repository";
import { createUnconfiguredDurableHookQueueResponse } from "@/fragno/durable-hooks";

describe("durable hook command repositories", () => {
  test("adapts finite Durable Object commands to the local repository interface", async () => {
    const getDurableHookQueue = vi.fn(async () => ({
      configured: true,
      hooksEnabled: true,
      namespace: "test",
      items: [],
      hasNextPage: false,
    }));
    const getDurableHook = vi.fn(async () => null);
    const repository = createDurableHookRepositoryFromCommands({
      getDurableHookQueue,
      getDurableHook,
    });

    await expect(repository.getHookQueue({ pageSize: 10 })).resolves.toMatchObject({
      namespace: "test",
    });
    await expect(repository.getHook("hook-1")).resolves.toBeNull();
    expect(getDurableHookQueue).toHaveBeenCalledWith({ pageSize: 10 });
    expect(getDurableHook).toHaveBeenCalledWith("hook-1");
  });

  test("constructs the finite unconfigured queue response", () => {
    expect(createUnconfiguredDurableHookQueueResponse()).toEqual({
      configured: false,
      hooksEnabled: false,
      namespace: null,
      items: [],
      cursor: undefined,
      hasNextPage: false,
    });
  });
});
