import type { HookProcessorConfig } from "./hooks";

type DurableHooksRuntimeState = {
  token: object;
  config: HookProcessorConfig;
  dispatcherRegistered: boolean;
  dispatcherWarningEmitted: boolean;
};

const runtimeByToken = new WeakMap<object, DurableHooksRuntimeState>();
const runtimeByConfig = new WeakMap<HookProcessorConfig, DurableHooksRuntimeState>();

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
