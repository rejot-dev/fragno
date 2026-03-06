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
const runtimesByInternalFragment = new WeakMap<
  HookProcessorConfig["internalFragment"],
  Map<string, DurableHooksRuntimeState>
>();

function getNamespaceRuntimeMap(
  internalFragment: HookProcessorConfig["internalFragment"],
  createIfMissing = false,
) {
  const existing = runtimesByInternalFragment.get(internalFragment);
  if (existing || !createIfMissing) {
    return existing;
  }
  const created = new Map<string, DurableHooksRuntimeState>();
  runtimesByInternalFragment.set(internalFragment, created);
  return created;
}

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
  const runtimeByNamespace = getNamespaceRuntimeMap(config.internalFragment, true);
  const existingForNamespace = runtimeByNamespace?.get(config.namespace);
  if (existingForNamespace && existingForNamespace.config !== config) {
    DurableHooksLogger.warn("Durable hooks runtime already registered for namespace", {
      namespace: config.namespace,
    });
  }
  runtimeByNamespace?.set(config.namespace, runtime);

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
  internalFragment: HookProcessorConfig["internalFragment"],
): DurableHooksRuntimeState | undefined {
  return getNamespaceRuntimeMap(internalFragment)?.get(namespace);
}

export function getDurableHooksNotifierByNamespace(
  namespace: string,
  internalFragment: HookProcessorConfig["internalFragment"],
) {
  return getNamespaceRuntimeMap(internalFragment)?.get(namespace)?.config.notifier;
}
