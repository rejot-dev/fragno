import type { AnySchema } from "../schema/create";
import type { AnyFragnoInstantiatedDatabaseFragment } from "../mod";
import {
  createHookScheduler,
  type DurableHooksProcessorScope,
  type HookProcessorConfig,
} from "./hooks";
import {
  getDurableHooksRuntimeByConfig,
  getDurableHooksRuntimeByToken,
} from "./durable-hooks-runtime";

export type DurableHooksProcessor = {
  process: () => Promise<number>;
  getNextWakeAt: () => Promise<Date | null>;
  drain: () => Promise<void>;
  namespace: string;
};

export type DurableHooksProcessorOptions = {
  scope?: DurableHooksProcessorScope;
};

export type DurableHooksProcessorGroupOptions = {
  onError?: (error: unknown) => void;
};

type DurableHooksInternal = {
  durableHooksToken?: object;
  durableHooks?: HookProcessorConfig;
};

const DEFAULT_STUCK_PROCESSING_TIMEOUT_MINUTES = 10;

function resolveStuckProcessingTimeoutMinutes(value: number | false | undefined): number | false {
  if (value === false) {
    return false;
  }
  if (typeof value === "number") {
    return value > 0 ? value : false;
  }
  return DEFAULT_STUCK_PROCESSING_TIMEOUT_MINUTES;
}

function hasDurableHooksConfigured(
  fragment: AnyFragnoInstantiatedDatabaseFragment,
): fragment is AnyFragnoInstantiatedDatabaseFragment {
  const internal = fragment.$internal as DurableHooksInternal | undefined;
  return Boolean(internal?.durableHooksToken ?? internal?.durableHooks);
}

export function createDurableHooksProcessor<TSchema extends AnySchema>(
  fragment: AnyFragnoInstantiatedDatabaseFragment<TSchema>,
  options: DurableHooksProcessorOptions = {},
): DurableHooksProcessor | null {
  const internal = fragment.$internal as DurableHooksInternal;
  let runtime = internal.durableHooks
    ? getDurableHooksRuntimeByConfig(internal.durableHooks)
    : internal.durableHooksToken
      ? getDurableHooksRuntimeByToken(internal.durableHooksToken)
      : undefined;
  const durableHooks = internal.durableHooks ?? runtime?.config;
  if (!durableHooks) {
    return null;
  }
  if (runtime) {
    runtime.dispatcherRegistered = true;
  }

  const { namespace, internalFragment } = durableHooks;
  const processorScope = options.scope;
  const stuckProcessingTimeoutMinutes = resolveStuckProcessingTimeoutMinutes(
    durableHooks.stuckProcessingTimeoutMinutes,
  );
  const scheduler = processorScope
    ? createHookScheduler(durableHooks, { processorScope })
    : (durableHooks.scheduler ?? (durableHooks.scheduler = createHookScheduler(durableHooks)));

  const applyProcessorScope = (context: {
    setShard: (shard: string | null) => void;
    setShardScope: (scope: "scoped" | "global") => void;
  }) => {
    if (!processorScope) {
      return;
    }
    if (processorScope.mode === "global") {
      context.setShardScope("global");
      context.setShard(null);
      return;
    }
    context.setShardScope("scoped");
    context.setShard(processorScope.shard);
  };

  return {
    namespace,
    process: async () => scheduler.schedule(),
    drain: async () => scheduler.drain(),
    getNextWakeAt: async () => {
      return await internalFragment.inContext(async function () {
        applyProcessorScope(this);
        return await this.handlerTx()
          .withServiceCalls(
            () =>
              [
                internalFragment.services.hookService.getNextHookWakeAt(
                  namespace,
                  stuckProcessingTimeoutMinutes,
                ),
              ] as const,
          )
          .transform(({ serviceResult: [result] }) => result)
          .execute();
      });
    },
  };
}

export function createDurableHooksProcessorGroup(
  fragments: readonly AnyFragnoInstantiatedDatabaseFragment[],
  options: DurableHooksProcessorGroupOptions = {},
): DurableHooksProcessor {
  const configuredFragments = fragments.filter(hasDurableHooksConfigured);
  if (configuredFragments.length === 0) {
    throw new Error("[fragno-db] No fragments provided for durable hooks processing.");
  }
  const processors = configuredFragments
    .map((fragment) => createDurableHooksProcessor(fragment))
    .filter((processor): processor is DurableHooksProcessor => Boolean(processor));

  return createDurableHooksProcessorGroupFromProcessors(processors, options);
}

export function createDurableHooksProcessorGroupFromProcessors(
  processors: readonly DurableHooksProcessor[],
  options: DurableHooksProcessorGroupOptions = {},
): DurableHooksProcessor {
  if (processors.length === 0) {
    throw new Error("[fragno-db] No processors provided for durable hooks processing.");
  }
  if (processors.length === 1) {
    return processors[0];
  }

  const onError = options.onError ?? (() => {});
  const namespace = processors.map((processor) => processor.namespace).join(",");

  return {
    namespace,
    process: async () => {
      const results = await Promise.allSettled(
        processors.map(async (processor) => await processor.process()),
      );
      let processed = 0;
      for (const result of results) {
        if (result.status === "fulfilled") {
          processed += result.value;
        } else {
          onError(result.reason);
        }
      }
      return processed;
    },
    drain: async () => {
      const results = await Promise.allSettled(
        processors.map(async (processor) => await processor.drain()),
      );
      for (const result of results) {
        if (result.status === "rejected") {
          onError(result.reason);
        }
      }
    },
    getNextWakeAt: async () => {
      const results = await Promise.allSettled(
        processors.map(async (processor) => await processor.getNextWakeAt()),
      );
      let nextWakeAt: Date | null = null;
      for (const result of results) {
        if (result.status === "fulfilled") {
          const wakeAt = result.value;
          if (!wakeAt) {
            continue;
          }
          if (!nextWakeAt || wakeAt.getTime() < nextWakeAt.getTime()) {
            nextWakeAt = wakeAt;
          }
        } else {
          onError(result.reason);
        }
      }
      return nextWakeAt;
    },
  };
}
