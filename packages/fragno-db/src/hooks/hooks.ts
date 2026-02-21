import type {
  ExecuteTxOptions,
  HandlerTxBuilder,
} from "../query/unit-of-work/execute-unit-of-work";
import type { RetryPolicy } from "../query/unit-of-work/retry-policy";
import { ExponentialBackoffRetryPolicy } from "../query/unit-of-work/retry-policy";
import type { IUnitOfWork } from "../query/unit-of-work/unit-of-work";
import { dbNow, isDbNow, type DbNow } from "../query/db-now";
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
   * Hook event identifier (versioned FragnoId).
   */
  hookId: FragnoId;
  /**
   * Hook name for this event.
   */
  hookName: string;
  /**
   * Current status of the hook event.
   */
  status: HookStatus;
  /**
   * Attempt count for this hook event.
   */
  attempts: number;
  /**
   * Maximum attempts configured for this hook event.
   */
  maxAttempts: number;
  /**
   * Timestamp of the last attempt (if any).
   */
  lastAttemptAt: Date | null;
  /**
   * Next scheduled retry timestamp (if any).
   */
  nextRetryAt: Date | null;
  /**
   * When the hook event was created.
   */
  createdAt: Date;
  /**
   * Create a handler transaction builder to run atomic operations.
   */
  handlerTx: HookHandlerTx;
}

export type HookStatus = "pending" | "processing" | "completed" | "failed";

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
  processAt?: Date | DbNow;
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
    const rawProcessAt = hook.options?.processAt ?? null;
    const processAt: Date | DbNow | null =
      rawProcessAt === null ? null : isDbNow(rawProcessAt) ? rawProcessAt : new Date(rawProcessAt);
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
  const internalSchema = internalFragment.$internal.deps.schema;
  const includeStuckProcessing = stuckProcessingTimeoutMinutes !== false;
  const staleBefore = includeStuckProcessing
    ? dbNow().plus({ minutes: -stuckProcessingTimeoutMinutes })
    : null;
  let claimedEvents: Array<{
    id: FragnoId;
    hookName: string;
    payload: unknown;
    status: HookStatus;
    attempts: number;
    maxAttempts: number;
    idempotencyKey: string;
    lastAttemptAt: Date | null;
    nextRetryAt: Date | null;
    createdAt: Date;
  }> = [];
  let stuckEvents: StuckHookProcessingEvent[] = [];

  const result = await internalFragment.inContext(async function () {
    return await this.handlerTx()
      .withServiceCalls(() => {
        const pending = internalFragment.services.hookService.claimPendingHookEvents(namespace);
        const stuck = includeStuckProcessing
          ? internalFragment.services.hookService.claimStuckProcessingHookEvents(
              namespace,
              staleBefore!,
            )
          : undefined;
        return [pending, stuck] as const;
      })
      .transform(({ serviceResult: [pendingEvents, stuckResult] }) => ({
        pendingEvents,
        stuckResult,
      }))
      .execute();
  });

  claimedEvents = [...result.pendingEvents, ...(result.stuckResult?.events ?? [])].map((event) => ({
    ...event,
    status: event.status as HookStatus,
  }));
  stuckEvents = result.stuckResult?.stuckEvents ?? [];

  if (includeStuckProcessing && stuckEvents.length > 0) {
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

  if (claimedEvents.length === 0) {
    return 0;
  }

  // Process events (async work outside transaction)
  const processedEvents = await Promise.allSettled(
    claimedEvents.map(async (event) => {
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
          hookId: event.id,
          hookName: event.hookName,
          status: event.status,
          attempts: event.attempts,
          maxAttempts: event.maxAttempts,
          lastAttemptAt: event.lastAttemptAt,
          nextRetryAt: event.nextRetryAt,
          createdAt: event.createdAt,
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
      .mutate(({ forSchema }) => {
        const uow = forSchema(internalSchema);
        const now = dbNow();

        for (const processedEvent of processedEvents) {
          if (processedEvent.status === "rejected") {
            console.error("Hook processing promise rejected", {
              namespace,
              error: processedEvent.reason,
            });
            continue;
          }

          const { eventId, status } = processedEvent.value;

          if (status === "completed") {
            uow.update("fragno_hooks", eventId, (b) =>
              b.set({ status: "completed", lastAttemptAt: now }).check(),
            );
            continue;
          }

          const { error, attempts } = processedEvent.value;
          const newAttempts = attempts + 1;
          const shouldRetry = retryPolicy.shouldRetry(newAttempts - 1);

          if (shouldRetry) {
            const delayMs = retryPolicy.getDelayMs(newAttempts - 1);
            const nextRetryAt = now.plus({ ms: delayMs });
            uow.update("fragno_hooks", eventId, (b) =>
              b
                .set({
                  status: "pending",
                  attempts: newAttempts,
                  lastAttemptAt: now,
                  nextRetryAt,
                  error,
                })
                .check(),
            );
          } else {
            uow.update("fragno_hooks", eventId, (b) =>
              b
                .set({
                  status: "failed",
                  attempts: newAttempts,
                  lastAttemptAt: now,
                  error,
                })
                .check(),
            );
          }
        }
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
