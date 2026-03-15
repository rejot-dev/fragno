import { describe, expect, it, vi } from "vitest";

import { DurableHooksLogger } from "./durable-hooks-logger";
import {
  getDurableHooksNotifierByNamespace,
  getDurableHooksRuntimeByConfig,
  getDurableHooksRuntimeByNamespace,
  getDurableHooksRuntimeByToken,
  registerDurableHooksRuntime,
} from "./durable-hooks-runtime";
import type { HookNotifier, HookProcessorConfig } from "./hooks";

let namespaceCounter = 0;
const defaultInternalFragment = {} as HookProcessorConfig["internalFragment"];

function createConfig(
  namespace: string,
  notifier?: HookNotifier,
  internalFragment: HookProcessorConfig["internalFragment"] = defaultInternalFragment,
): HookProcessorConfig {
  return {
    namespace,
    hooks: {},
    notifier,
    internalFragment,
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

  it("keeps the latest runtime for scoped namespace lookup and warns on duplicates", () => {
    const warnSpy = vi.spyOn(DurableHooksLogger, "warn").mockImplementation(() => {});
    const namespace = `runtime-duplicate-${namespaceCounter++}`;
    const internalFragment = {} as HookProcessorConfig["internalFragment"];
    const firstConfig = createConfig(namespace, undefined, internalFragment);
    const notifier: HookNotifier = {
      notify: vi.fn(),
    };
    const secondConfig = createConfig(namespace, notifier, internalFragment);

    const firstToken = registerDurableHooksRuntime(firstConfig);
    const secondToken = registerDurableHooksRuntime(secondConfig);

    expect(firstToken).not.toBe(secondToken);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(getDurableHooksRuntimeByNamespace(namespace, internalFragment)?.token).toBe(secondToken);
    expect(getDurableHooksNotifierByNamespace(namespace, internalFragment)).toBe(notifier);

    warnSpy.mockRestore();
  });
});
