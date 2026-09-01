import type { AnyFragnoInstantiatedDatabaseFragment } from "../mod";
import { getDurableHooksToken, hasDurableHooksConfigured } from "./durable-hooks-fragment";
import { DurableHooksLogger } from "./durable-hooks-logger";
import { getDurableHooksRuntimeByToken } from "./durable-hooks-runtime";
import {
  createDurableHooksRunner,
  type DurableHooksInstrumentation,
  type DurableHooksRun,
} from "./hooks";

export type DurableHooksProcessor = {
  processDue: () => Promise<DurableHooksRun>;
  getNextWakeAt: () => Promise<Date | null>;
  drain: () => Promise<void>;
  namespace: string;
};

export type DurableHooksProcessorOptions = {
  /**
   * Overrides the fragment's durable-hook instrumentation for both enqueue-time context capture and
   * attempt processing. Integrations should set this before exposing the hosted fragment.
   */
  instrumentation?: DurableHooksInstrumentation;
};

/** Observes durable hook failures; the lifecycle reporting the failure awaits async observers. */
export type DurableHooksErrorObserver = (error: unknown) => void | Promise<void>;

export type DurableHooksProcessorGroupOptions = DurableHooksProcessorOptions & {
  onError?: DurableHooksErrorObserver;
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

export function createDurableHooksProcessor(
  fragment: AnyFragnoInstantiatedDatabaseFragment,
  options: DurableHooksProcessorOptions = {},
): DurableHooksProcessor {
  const durableHooksToken = getDurableHooksToken(fragment);
  if (!durableHooksToken) {
    throw new Error(`[fragno-db] Durable hooks not configured for fragment "${fragment.name}".`);
  }
  const runtime = getDurableHooksRuntimeByToken(durableHooksToken);
  if (!runtime) {
    throw new Error(`[fragno-db] Durable hooks runtime missing for fragment "${fragment.name}".`);
  }
  runtime.dispatcherRegistered = true;

  const durableHooks = runtime.config;
  if (options.instrumentation !== undefined) {
    durableHooks.instrumentation = options.instrumentation;
  }

  const { namespace, internalFragment } = durableHooks;
  const stuckProcessingTimeoutMinutes = resolveStuckProcessingTimeoutMinutes(
    durableHooks.stuckProcessingTimeoutMinutes,
  );
  const runner =
    durableHooks.runner ?? (durableHooks.runner = createDurableHooksRunner(durableHooks));

  return {
    namespace,
    processDue: async () => runner.processDue(),
    drain: async () => runner.drain(),
    getNextWakeAt: async () => {
      return await internalFragment.inContext(async function () {
        return await this.handlerTx({
          name: `internal.hooks.${namespace}.getNextWakeAt`,
          transactionInstrumentation: durableHooks.transactionInstrumentation,
        })
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
  const processors = configuredFragments.map((fragment) =>
    createDurableHooksProcessor(fragment, { instrumentation: options.instrumentation }),
  );

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

  async function reportProcessorGroupError(error: unknown): Promise<void> {
    try {
      await onError(error);
    } catch (callbackError) {
      DurableHooksLogger.error("Durable hooks processor group onError callback failed", {
        namespace,
        fields: { error: DurableHooksLogger.toErrorMessage(callbackError) },
      });
    }
  }

  const processDue = async (): Promise<DurableHooksRun> => {
    const results = await Promise.allSettled(
      processors.map(async (processor) => await processor.processDue()),
    );
    const runs: DurableHooksRun[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        runs.push(result.value);
      } else {
        await reportProcessorGroupError(result.reason);
      }
    }

    return {
      claimedCount: runs.reduce((count, run) => count + run.claimedCount, 0),
      completion: Promise.allSettled(runs.map((run) => run.completion)).then(
        async (completionResults) => {
          let processed = 0;
          for (const result of completionResults) {
            if (result.status === "fulfilled") {
              processed += result.value;
            } else {
              await reportProcessorGroupError(result.reason);
            }
          }
          return processed;
        },
      ),
    };
  };

  return {
    namespace,
    processDue,
    drain: async () => {
      const results = await Promise.allSettled(
        processors.map(async (processor) => {
          await processor.drain();
        }),
      );
      for (const result of results) {
        if (result.status === "rejected") {
          await reportProcessorGroupError(result.reason);
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
          await reportProcessorGroupError(result.reason);
        }
      }
      return nextWakeAt;
    },
  };
}
