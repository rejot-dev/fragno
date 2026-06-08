import { describe, expect, test } from "vitest";

import { RpcTarget } from "cloudflare:workers";

import {
  createDurableHookRepositoryRpcTarget,
  createEmptyDurableHookRepository,
} from "@/fragno/durable-hooks";

describe("durable hook repositories over Durable Object RPC", () => {
  test("wraps repository implementations in RpcTarget instances", async () => {
    const repository = createDurableHookRepositoryRpcTarget({
      getHookQueue: async () => ({
        configured: true,
        hooksEnabled: true,
        namespace: "test",
        items: [],
        hasNextPage: false,
      }),
      getHook: async () => null,
    });

    expect(repository).toBeInstanceOf(RpcTarget);
    await expect(repository.getHookQueue()).resolves.toMatchObject({ namespace: "test" });
  });

  test("wraps empty repositories in RpcTarget instances too", () => {
    expect(createEmptyDurableHookRepository()).toBeInstanceOf(RpcTarget);
  });
});
