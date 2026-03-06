import type { HookProcessorConfig } from "./hooks";
import { DurableHooksLogger } from "./durable-hooks-logger";

type DurableHooksRuntimeState = {
  token: object;
  config: HookProcessorConfig;
  dispatcherRegistered: boolean;
  dispatcherWarningEmitted: boolean;
};

const runtimeByToken = new WeakMap<object, DurableHooksRuntimeState>();
const runtimeByConfig = new WeakMap<HookProcessorConfig, DurableHooksRuntimeState>();
const runtimeByNamespace = new Map<string, DurableHooksRuntimeState>();

export function registerDurableHooksRuntime(config: HookProcessorConfig): object {
  const existing = runtimeByConfig.get(config);
  if (existing) {
    return existing.token;
  }

  const token = {};
  const runtime: DurableHooksRuntimeState = {
    token,
    config,
    dispatcherRegistered: false,
    dispatcherWarningEmitted: false,
  };

  runtimeByToken.set(token, runtime);
  runtimeByConfig.set(config, runtime);
  const existingForNamespace = runtimeByNamespace.get(config.namespace);
  if (existingForNamespace && existingForNamespace.config !== config) {
    DurableHooksLogger.warn("Durable hooks runtime already registered for namespace", {
      namespace: config.namespace,
    });
  }
  // Always keep the newest runtime registration per namespace so lookups do not
  // depend on older in-process instances.
  runtimeByNamespace.set(config.namespace, runtime);

  return token;
}

export function getDurableHooksRuntimeByToken(token: object): DurableHooksRuntimeState | undefined {
  return runtimeByToken.get(token);
}

export function getDurableHooksRuntimeByConfig(
  config: HookProcessorConfig,
): DurableHooksRuntimeState | undefined {
  return runtimeByConfig.get(config);
}

export function getDurableHooksRuntimeByNamespace(
  namespace: string,
): DurableHooksRuntimeState | undefined {
  return runtimeByNamespace.get(namespace);
}

export function getDurableHooksNotifierByNamespace(namespace: string) {
  return runtimeByNamespace.get(namespace)?.config.notifier;
}
