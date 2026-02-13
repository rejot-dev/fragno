import type { AnySchema } from "../schema/create";
import type { AnyFragnoInstantiatedDatabaseFragment } from "../mod";
import {
  createHookScheduler,
  type DurableHooksProcessorScope,
  type HookProcessorConfig,
} from "./hooks";

export type DurableHooksProcessor = {
  process: () => Promise<number>;
  getNextWakeAt: () => Promise<Date | null>;
  drain: () => Promise<void>;
  namespace: string;
};

export type DurableHooksProcessorOptions = {
  scope?: DurableHooksProcessorScope;
};

type DurableHooksInternal = {
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

export function createDurableHooksProcessor<TSchema extends AnySchema>(
  fragment: AnyFragnoInstantiatedDatabaseFragment<TSchema>,
  options: DurableHooksProcessorOptions = {},
): DurableHooksProcessor | null {
  const durableHooks = (fragment.$internal as DurableHooksInternal).durableHooks;
  if (!durableHooks) {
    return null;
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
      const now = new Date();
      return await internalFragment.inContext(async function () {
        applyProcessorScope(this);
        return await this.handlerTx()
          .withServiceCalls(
            () =>
              [
                internalFragment.services.hookService.getNextHookWakeAt(
                  namespace,
                  stuckProcessingTimeoutMinutes,
                  now,
                ),
              ] as const,
          )
          .transform(({ serviceResult: [result] }) => result)
          .execute();
      });
    },
  };
}
