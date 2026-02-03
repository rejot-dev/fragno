import type { AnySchema } from "../schema/create";
import type { AnyFragnoInstantiatedDatabaseFragment } from "../mod";
import { createHookScheduler, type HookProcessorConfig } from "./hooks";

export type DurableHooksProcessor = {
  process: () => Promise<number>;
  getNextWakeAt: () => Promise<Date | null>;
  drain: () => Promise<void>;
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

export function createDurableHooksProcessor<TSchema extends AnySchema>(
  fragment: AnyFragnoInstantiatedDatabaseFragment<TSchema>,
): DurableHooksProcessor | null {
  const durableHooks = (fragment.$internal as DurableHooksInternal).durableHooks;
  if (!durableHooks) {
    return null;
  }

  const { namespace, internalFragment } = durableHooks;
  const stuckProcessingTimeoutMinutes = resolveStuckProcessingTimeoutMinutes(
    durableHooks.stuckProcessingTimeoutMinutes,
  );
  const scheduler =
    durableHooks.scheduler ?? (durableHooks.scheduler = createHookScheduler(durableHooks));

  return {
    namespace,
    process: async () => scheduler.schedule(),
    drain: async () => scheduler.drain(),
    getNextWakeAt: async () => {
      const services = internalFragment.services as { getDbNow?: () => Promise<Date> };
      const now = services.getDbNow ? await services.getDbNow() : new Date();
      return await internalFragment.inContext(async function () {
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
