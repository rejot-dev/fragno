import type { AnyFragnoInstantiatedDatabaseFragment } from "../mod";
import { processHooks, type HookProcessorConfig } from "./hooks";

export type DurableHooksProcessor = {
  process: () => Promise<number>;
  getNextWakeAt: () => Promise<Date | null>;
  namespace: string;
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

export function createDurableHooksProcessor(
  fragment: AnyFragnoInstantiatedDatabaseFragment,
): DurableHooksProcessor | null {
  const durableHooks = (fragment.$internal as DurableHooksInternal).durableHooks;
  if (!durableHooks) {
    return null;
  }

  const { namespace, internalFragment } = durableHooks;
  const stuckProcessingTimeoutMinutes = resolveStuckProcessingTimeoutMinutes(
    durableHooks.stuckProcessingTimeoutMinutes,
  );

  return {
    namespace,
    process: async () => processHooks(durableHooks),
    getNextWakeAt: async () => {
      return await internalFragment.inContext(async function () {
        if (stuckProcessingTimeoutMinutes === false) {
          return await this.handlerTx()
            .withServiceCalls(
              () => [internalFragment.services.hookService.getNextHookWakeAt(namespace)] as const,
            )
            .transform(({ serviceResult: [result] }) => result)
            .execute();
        }

        return await this.handlerTx()
          .withServiceCalls(
            () =>
              [
                internalFragment.services.hookService.getNextHookWakeAt(namespace),
                internalFragment.services.hookService.getNextProcessingStaleAt(
                  namespace,
                  stuckProcessingTimeoutMinutes,
                ),
              ] as const,
          )
          .transform(({ serviceResult: [nextHookWakeAt, nextStaleAt] }) => {
            if (!nextHookWakeAt) {
              return nextStaleAt ?? null;
            }
            if (!nextStaleAt) {
              return nextHookWakeAt;
            }
            return nextHookWakeAt <= nextStaleAt ? nextHookWakeAt : nextStaleAt;
          })
          .execute();
      });
    },
  };
}
