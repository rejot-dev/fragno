import type {
  ExecuteTxOptions,
  HandlerTxBuilder,
} from "../query/unit-of-work/execute-unit-of-work";
import type { RetryPolicy } from "../query/unit-of-work/retry-policy";
import { ExponentialBackoffRetryPolicy } from "../query/unit-of-work/retry-policy";
import type { IUnitOfWork } from "../query/unit-of-work/unit-of-work";
import type { TxResult } from "../query/unit-of-work/execute-unit-of-work";
import type { FragnoId } from "../schema/create";
import type { InternalFragmentInstance } from "../fragments/internal-fragment";

/**
 * Context available in hook functions via `this`.
 * Contains the idempotency key for idempotency and database access.
 */
export interface HookContext {
  /**
   * Unique idempotency key for this transaction.
   * Use this for idempotency checks in your hook implementation.
   */
  idempotencyKey: string;
  /**
   * Create a handler transaction builder to run atomic operations.
   */
  handlerTx: HookHandlerTx;
}

/**
 * A hook function signature.
 * Hooks receive a typed payload and access context via `this`.
 */
export type HookFn<TPayload = unknown> = (payload: TPayload) => void | Promise<void>;

/**
 * Map of hook names to hook functions.
 * Used for type-safe hook definitions and triggering.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HooksMap = Record<string, HookFn<any>>;

/**
 * Extract the payload type from a hook function.
 */
export type HookPayload<T> = T extends HookFn<infer P> ? P : never;

/**
 * Options for triggering a hook.
 */
export interface TriggerHookOptions {
  /**
   * Optional retry policy override for this specific hook trigger.
   * If not provided, uses the default retry policy.
   */
  retryPolicy?: RetryPolicy;
  /**
   * Absolute time for the first attempt. If in the future, the hook is
   * scheduled for that time; if in the past, it runs immediately.
   */
  processAt?: Date;
}

/**
 * Internal representation of a triggered hook.
 * Stored in the Unit of Work before execution.
 */
export interface TriggeredHook {
  hookName: string;
  payload: unknown;
  options?: TriggerHookOptions;
}

export type HookScheduler = {
  schedule: () => Promise<number>;
  drain: () => Promise<void>;
};

/**
 * Configuration for hook processing.
 */
export interface HookProcessorConfig<THooks extends HooksMap = HooksMap> {
  hooks: THooks;
  namespace: string;
  internalFragment: InternalFragmentInstance;
  handlerTx: HookHandlerTx;
  /**
   * Internal hook scheduler used to coordinate processing/drain.
   */
  scheduler?: HookScheduler;
  defaultRetryPolicy?: RetryPolicy;
  /**
   * Re-queue hooks that have been in `processing` for at least this many minutes.
   * Use `false` to disable stuck-processing recovery entirely.
   * Values <= 0 are treated as `false`.
   *
   * Default: 10 minutes.
   */
  stuckProcessingTimeoutMinutes?: StuckHookProcessingTimeoutMinutes;
  /**
   * Called when stuck processing hooks are detected and re-queued.
   * Invoked after the hooks are moved back to `pending`.
   */
  onStuckProcessingHooks?: (info: StuckHookProcessingInfo) => void;
}

export type StuckHookProcessingTimeoutMinutes = number | false;

export type StuckHookProcessingEvent = {
  id: FragnoId;
  hookName: string;
  attempts: number;
  maxAttempts: number;
  lastAttemptAt: Date | null;
  nextRetryAt: Date | null;
};

export type StuckHookProcessingInfo = {
  namespace: string;
  timeoutMinutes: number;
  events: StuckHookProcessingEvent[];
};

export type DurableHooksProcessingOptions = {
  /**
   * Re-queue hooks that have been in `processing` for at least this many minutes.
   * Use `false` to disable stuck-processing recovery entirely.
   * Values <= 0 are treated as `false`.
   *
   * Default: 10 minutes.
   */
  stuckProcessingTimeoutMinutes?: StuckHookProcessingTimeoutMinutes;
  /**
   * Called when stuck processing hooks are detected and re-queued.
   * Invoked after the hooks are moved back to `pending`.
   */
  onStuckProcessingHooks?: (info: StuckHookProcessingInfo) => void;
};

export type HookHandlerTx = (
  execOptions?: Omit<ExecuteTxOptions, "createUnitOfWork">,
) => HandlerTxBuilder<readonly [], [], [], unknown, unknown, false, false, false, false, HooksMap>;

const DEFAULT_STUCK_PROCESSING_TIMEOUT_MINUTES = 10;

function resolveStuckProcessingTimeoutMinutes(
  value: StuckHookProcessingTimeoutMinutes | undefined,
): number | false {
  if (value === false) {
    return false;
  }
  if (typeof value === "number") {
    return value > 0 ? value : false;
  }
  return DEFAULT_STUCK_PROCESSING_TIMEOUT_MINUTES;
}

/**
 * Add hook events as mutation operations to the UOW.
 * This should be called before executeMutations() so hook records are created
 * in the same transaction as the user's mutations.
 */
export function prepareHookMutations<THooks extends HooksMap>(
  uow: IUnitOfWork,
  config: HookProcessorConfig<THooks>,
): void {
  const { namespace, internalFragment, defaultRetryPolicy } = config;
  const retryPolicy = defaultRetryPolicy ?? new ExponentialBackoffRetryPolicy({ maxRetries: 5 });

  const triggeredHooks = uow.getTriggeredHooks();

  if (triggeredHooks.length === 0) {
    return;
  }

  const internalSchema = internalFragment.$internal.deps.schema;
  const internalUow = uow.forSchema(internalSchema);

  for (const hook of triggeredHooks) {
    const hookRetryPolicy = hook.options?.retryPolicy ?? retryPolicy;
    const maxAttempts = hookRetryPolicy.shouldRetry(4) ? 5 : 1;
    const processAt = hook.options?.processAt ? new Date(hook.options.processAt) : null;
    const nextRetryAt = processAt ?? null;
    internalUow.create("fragno_hooks", {
      namespace,
      hookName: hook.hookName,
      payload: hook.payload,
      status: "pending",
      attempts: 0,
      maxAttempts,
      lastAttemptAt: null,
      nextRetryAt,
      error: null,
      nonce: uow.idempotencyKey,
    });
  }
}

/**
 * Process pending hook events after the transaction has committed.
 * This should be called in the onSuccess callback after executeMutations().
 */
export async function processHooks<THooks extends HooksMap>(
  config: HookProcessorConfig<THooks>,
): Promise<number> {
  const { hooks, namespace, internalFragment, defaultRetryPolicy } = config;
  const retryPolicy = defaultRetryPolicy ?? new ExponentialBackoffRetryPolicy({ maxRetries: 5 });
  const stuckProcessingTimeoutMinutes = resolveStuckProcessingTimeoutMinutes(
    config.stuckProcessingTimeoutMinutes,
  );
  const getDbNow = async () => {
    const services = internalFragment.services as { getDbNow?: () => Promise<Date> };
    if (services.getDbNow) {
      return services.getDbNow();
    }
    return new Date();
  };
  const dbNow = await getDbNow();

  if (stuckProcessingTimeoutMinutes !== false) {
    const staleBefore = new Date(dbNow.getTime() - stuckProcessingTimeoutMinutes * 60_000);
    const stuckEvents = await internalFragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () =>
            [
              internalFragment.services.hookService.requeueStuckProcessingHooks(
                namespace,
                staleBefore,
              ),
            ] as const,
        )
        .transform(({ serviceResult: [events] }) => events)
        .execute();
    });

    if (stuckEvents.length > 0) {
      try {
        config.onStuckProcessingHooks?.({
          namespace,
          timeoutMinutes: stuckProcessingTimeoutMinutes,
          events: stuckEvents,
        });
      } catch (error) {
        console.error("Error calling onStuckProcessingHooks", error);
      }
    }
  }

  // Claim pending events in the same transaction to avoid double-processing.
  const pendingEvents = await internalFragment.inContext(async function () {
    return await this.handlerTx()
      .withServiceCalls(
        () => [internalFragment.services.hookService.claimPendingHookEvents(namespace)] as const,
      )
      .transform(({ serviceResult: [events] }) => events)
      .execute();
  });

  if (pendingEvents.length === 0) {
    return 0;
  }

  // Process events (async work outside transaction)
  const processedEvents = await Promise.allSettled(
    pendingEvents.map(async (event) => {
      const hookFn = hooks[event.hookName];
      if (!hookFn) {
        return {
          eventId: event.id,
          status: "failed" as const,
          error: `Hook '${event.hookName}' not found in hooks map`,
          attempts: event.attempts,
          maxAttempts: event.maxAttempts,
        };
      }

      try {
        const hookContext: HookContext = {
          idempotencyKey: event.idempotencyKey,
          handlerTx: config.handlerTx,
        };
        await hookFn.call(hookContext, event.payload);
        return {
          eventId: event.id,
          status: "completed" as const,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          eventId: event.id,
          status: "failed" as const,
          error: errorMessage,
          attempts: event.attempts,
          maxAttempts: event.maxAttempts,
        };
      }
    }),
  );

  // Mark events as completed/failed
  await internalFragment.inContext(async function () {
    await this.handlerTx()
      .withServiceCalls(() => {
        const txResults: TxResult<void>[] = [];
        for (const processedEvent of processedEvents) {
          if (processedEvent.status === "rejected") {
            continue;
          }

          const { eventId, status } = processedEvent.value;

          if (status === "completed") {
            txResults.push(internalFragment.services.hookService.markHookCompleted(eventId));
          } else if (status === "failed") {
            const { error, attempts } = processedEvent.value;
            txResults.push(
              internalFragment.services.hookService.markHookFailed(
                eventId,
                error,
                attempts,
                retryPolicy,
                dbNow,
              ),
            );
          }
        }
        return txResults;
      })
      .execute();
  });

  const processedCount = processedEvents.reduce(
    (count, result) => count + (result.status === "fulfilled" ? 1 : 0),
    0,
  );

  return processedCount;
}

export function createHookScheduler(config: HookProcessorConfig): HookScheduler {
  let processing = false;
  let queued = false;
  let currentPromise: Promise<number> | null = null;

  const schedule = async () => {
    if (processing) {
      queued = true;
      return currentPromise ?? Promise.resolve(0);
    }

    processing = true;
    currentPromise = (async () => {
      let lastCount = 0;
      try {
        do {
          queued = false;
          lastCount = await processHooks(config);
        } while (queued);
        return lastCount;
      } finally {
        processing = false;
        queued = false;
      }
    })();

    return currentPromise;
  };

  const drain = async () => {
    while (true) {
      const processed = await schedule();
      if (processed === 0) {
        return;
      }
    }
  };

  return { schedule, drain };
}
