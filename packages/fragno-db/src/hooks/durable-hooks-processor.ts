import type { AnyFragnoInstantiatedDatabaseFragment } from "../mod";
import { getDurableHooksRuntimeByToken } from "./durable-hooks-runtime";
import { createDurableHooksRunner } from "./hooks";

export type DurableHooksProcessor = {
  processDue: () => Promise<number>;
  /**
   * @deprecated Use processDue().
   */
  process: () => Promise<number>;
  getNextWakeAt: () => Promise<Date | null>;
  drain: () => Promise<void>;
  namespace: string;
};

export type DurableHooksProcessorGroupOptions = {
  onError?: (error: unknown) => void;
};

type DurableHooksInternal = {
  durableHooksToken?: object;
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
  return Boolean(internal?.durableHooksToken);
}

export function createDurableHooksProcessor(
  fragment: AnyFragnoInstantiatedDatabaseFragment,
): DurableHooksProcessor {
  const durableHooksToken = (fragment.$internal as DurableHooksInternal).durableHooksToken;
  if (!durableHooksToken) {
    throw new Error(`[fragno-db] Durable hooks not configured for fragment "${fragment.name}".`);
  }
  const runtime = getDurableHooksRuntimeByToken(durableHooksToken);
  if (!runtime) {
    throw new Error(`[fragno-db] Durable hooks runtime missing for fragment "${fragment.name}".`);
  }
  runtime.dispatcherRegistered = true;

  const durableHooks = runtime.config;

  const { namespace, internalFragment } = durableHooks;
  const stuckProcessingTimeoutMinutes = resolveStuckProcessingTimeoutMinutes(
    durableHooks.stuckProcessingTimeoutMinutes,
  );
  const runner =
    durableHooks.runner ??
    (durableHooks.runner = durableHooks.scheduler
      ? {
          processDue: () => durableHooks.scheduler!.schedule(),
          drain: () => durableHooks.scheduler!.drain(),
        }
      : createDurableHooksRunner(durableHooks));

  return {
    namespace,
    processDue: async () => runner.processDue(),
    process: async () => runner.processDue(),
    drain: async () => runner.drain(),
    getNextWakeAt: async () => {
      return await internalFragment.inContext(async function () {
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
  const processors = configuredFragments.map((fragment) => createDurableHooksProcessor(fragment));

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

  const processDue = async () => {
    const results = await Promise.allSettled(
      processors.map(async (processor) => await processor.processDue()),
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
  };

  return {
    namespace,
    processDue,
    process: processDue,
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
