import { describe, expect, it, vi } from "vitest";
import type { HookNotifier, HookProcessorConfig } from "./hooks";
import { DurableHooksLogger } from "./durable-hooks-logger";
import {
  getDurableHooksNotifierByNamespace,
  getDurableHooksRuntimeByConfig,
  getDurableHooksRuntimeByNamespace,
  getDurableHooksRuntimeByToken,
  registerDurableHooksRuntime,
} from "./durable-hooks-runtime";

let namespaceCounter = 0;

function createConfig(namespace: string, notifier?: HookNotifier): HookProcessorConfig {
  return {
    namespace,
    hooks: {},
    notifier,
    internalFragment: {} as HookProcessorConfig["internalFragment"],
    handlerTx: (() => {
      throw new Error("handlerTx should not be called in durable-hooks-runtime tests");
    }) as HookProcessorConfig["handlerTx"],
  };
}

describe("durable hooks runtime registry", () => {
  it("returns the same token when registering the same config twice", () => {
    const namespace = `runtime-same-config-${namespaceCounter++}`;
    const config = createConfig(namespace);

    const tokenA = registerDurableHooksRuntime(config);
    const tokenB = registerDurableHooksRuntime(config);

    expect(tokenA).toBe(tokenB);
    expect(getDurableHooksRuntimeByToken(tokenA)?.config).toBe(config);
    expect(getDurableHooksRuntimeByConfig(config)?.token).toBe(tokenA);
  });

  it("keeps the latest runtime for namespace lookup and warns on duplicates", () => {
    const warnSpy = vi.spyOn(DurableHooksLogger, "warn").mockImplementation(() => {});
    const namespace = `runtime-duplicate-${namespaceCounter++}`;
    const firstConfig = createConfig(namespace);
    const notifier: HookNotifier = {
      notify: vi.fn(),
    };
    const secondConfig = createConfig(namespace, notifier);

    const firstToken = registerDurableHooksRuntime(firstConfig);
    const secondToken = registerDurableHooksRuntime(secondConfig);

    expect(firstToken).not.toBe(secondToken);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(getDurableHooksRuntimeByNamespace(namespace)?.token).toBe(secondToken);
    expect(getDurableHooksNotifierByNamespace(namespace)).toBe(notifier);

    warnSpy.mockRestore();
  });
});
