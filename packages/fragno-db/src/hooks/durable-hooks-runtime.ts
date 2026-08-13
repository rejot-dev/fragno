import { DurableHooksLogger } from "./durable-hooks-logger";
import type { HookProcessorConfig } from "./hooks";

declare const durableHooksRuntimeTokenBrand: unique symbol;

export type DurableHooksRuntimeToken = {
  readonly [durableHooksRuntimeTokenBrand]?: never;
};

type DurableHooksRuntimeState = {
  token: DurableHooksRuntimeToken;
  config: HookProcessorConfig;
  dispatcherRegistered: boolean;
  dispatcherWarningEmitted: boolean;
};

const runtimeByToken = new WeakMap<DurableHooksRuntimeToken, DurableHooksRuntimeState>();
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

export function registerDurableHooksRuntime(config: HookProcessorConfig): DurableHooksRuntimeToken {
  const existing = runtimeByConfig.get(config);
  if (existing) {
    return existing.token;
  }

  const token: DurableHooksRuntimeToken = {};
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

export function getDurableHooksRuntimeByToken(
  token: DurableHooksRuntimeToken,
): DurableHooksRuntimeState | undefined {
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
