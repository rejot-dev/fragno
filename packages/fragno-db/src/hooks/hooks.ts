import type { InternalFragmentInstance } from "../fragments/internal-fragment";
import { internalSchema } from "../fragments/internal-fragment.schema";
import { dbNow, isDbNow, type DbNow } from "../query/db-now";
import type {
  DatabaseTransactionInstrumentation,
  ExecuteTxOptions,
  HandlerTxBuilder,
} from "../query/unit-of-work/execute-unit-of-work";
import type { IUnitOfWork } from "../query/unit-of-work/unit-of-work";
import type { FragnoId } from "../schema/create";
import {
  assertDurableHookRetryPolicy,
  defaultDurableHookRetryPolicy,
  durableHookRetryDelayMs,
  type DurableHookRetryPolicy,
} from "./durable-hook-retry-policy";
import { DurableHooksLogger, type DurableHooksLoggerConfig } from "./durable-hooks-logger";
import { getDurableHooksRuntimeByNamespace } from "./durable-hooks-runtime";

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
   * Maximum attempts allowed by this hook's retry policy.
   */
  maxAttempts: number;
  /**
   * Propagation context captured when the hook was enqueued.
   */
  readonly propagationContext: DurableHookPropagationContext | null;
  /**
   * Capture the currently active attempt context for an outbound call.
   * Falls back to `propagationContext` when instrumentation has no active context.
   */
  capturePropagationContext(): DurableHookPropagationContext | null;
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

export const hookStatusValues = ["pending", "processing", "completed", "failed"] as const;

export type HookStatus = (typeof hookStatusValues)[number];

export const isHookStatus = (value: unknown): value is HookStatus =>
  typeof value === "string" && hookStatusValues.includes(value as HookStatus);

const assertHookStatus = (value: unknown): HookStatus => {
  if (isHookStatus(value)) {
    return value;
  }
  throw new Error(`Invalid hook status: ${String(value)}`);
};

/**
 * A hook function signature.
 * Hooks receive a typed payload and access context via `this`.
 */
export type HookFn<TPayload = unknown> = ((payload: TPayload) => void | Promise<void>) & {
  readonly retryPolicy: DurableHookRetryPolicy;
};

export type DefineDurableHookOptions = {
  /** Defaults to `defaultDurableHookRetryPolicy`. */
  retryPolicy?: DurableHookRetryPolicy;
};

/** Pairs a hook function with the retry policy the processor applies to its failed attempts. */
export function defineDurableHook<TPayload>(
  hook: (this: HookContext, payload: TPayload) => void | Promise<void>,
  { retryPolicy = defaultDurableHookRetryPolicy }: DefineDurableHookOptions = {},
): HookFn<TPayload> {
  assertDurableHookRetryPolicy(retryPolicy);
  return Object.assign(
    function (this: HookContext, payload: TPayload) {
      return hook.call(this, payload);
    },
    { retryPolicy },
  );
}

/** A queued hook whose definition is missing may be defined by a later deploy, so it keeps retrying. */
function resolveDurableHookRetryPolicy(hook: HookFn | undefined): DurableHookRetryPolicy {
  return hook?.retryPolicy ?? defaultDurableHookRetryPolicy;
}

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
 * Opaque text-map carrier persisted with a durable hook.
 * Integrations can use this to propagate tracing or other execution context.
 */
export type DurableHookPropagationContext = Readonly<Record<string, string>>;

export type DurableHookEnqueueInfo = {
  namespace: string;
  hookName: string;
  idempotencyKey: string;
};

export type DurableHookAttempt = {
  namespace: string;
  hookId: FragnoId;
  hookName: string;
  idempotencyKey: string;
  attempt: number;
  maxAttempts: number;
  createdAt: Date;
  propagationContext: DurableHookPropagationContext | null;
};

/** What the processor recorded for one hook attempt. */
export type DurableHookAttemptOutcome =
  | { status: "completed" }
  | { status: "retry-scheduled"; error: unknown }
  /** The hook used up its attempts or its retry policy deemed the error not retryable. */
  | { status: "failed"; error: unknown };

export type DurableHookNotification = {
  namespace: string;
  correlationId: string;
  source: HookNotifySource;
  route?: string | null;
  crossNamespace: boolean;
  queued: number;
};

/**
 * Optional integration boundary for durable-hook context propagation and lifecycle instrumentation.
 */
export interface DurableHooksInstrumentation {
  /** Capture the current ambient context without producing side effects. */
  captureContext(info: DurableHookEnqueueInfo): DurableHookPropagationContext | null;
  /**
   * Run one hook attempt with its persisted context restored.
   * Implementations must call `execute` exactly once and preserve its result or error.
   */
  runAttempt<T>(attempt: DurableHookAttempt, execute: () => Promise<T>): Promise<T>;
  /** Wrap one dispatcher notification without changing whether notification succeeds. */
  runNotify?<T>(notification: DurableHookNotification, execute: () => Promise<T>): Promise<T>;
  /**
   * Observe an attempt's outcome once it is committed, so observers never report an outcome that
   * a concurrent writer overruled. Errors thrown here are logged and do not change the outcome.
   */
  observeAttemptOutcome?(attempt: DurableHookAttempt, outcome: DurableHookAttemptOutcome): void;
  /**
   * Observe hooks that sat in `processing` past the stuck-processing timeout, after they are moved
   * back to `pending`: their attempt died with its runtime, such as an alarm that ran out of memory.
   * Errors thrown here are logged and do not change the recovery.
   */
  observeStuckProcessingHooks?(info: StuckHookProcessingInfo): void;
}

/**
 * Options for triggering a hook.
 */
export interface TriggerHookOptions {
  /**
   * Optional hook event ID. When provided, the hook insert will fail if a hook
   * with the same ID already exists. Completed hooks are deleted after their retention
   * (`completedHookRetentionMinutes`), so the ID rejects duplicates only until then.
   */
  id?: string | FragnoId;
  /**
   * Absolute time for the first attempt. If in the future, the hook is
   * scheduled for that time; if in the past, it runs immediately.
   */
  processAt?: Date | DbNow;
  /**
   * Propagation context for this hook event.
   *
   * - `undefined`: capture ambient context from the configured instrumentation.
   * - `null`: suppress context propagation.
   * - object: persist exactly this context.
   */
  propagationContext?: DurableHookPropagationContext | null;
}

/**
 * Internal representation of a triggered hook.
 * Stored in the Unit of Work before execution.
 */
export interface TriggeredHook {
  namespace: string;
  hookName: string;
  payload: unknown;
  options?: TriggerHookOptions;
}

export type HookNotifySource = "request" | "hook" | "alarm";

export type HookNotifyContext = {
  source: HookNotifySource;
  route?: string | null;
};

export type HookNotifier = {
  /** Resolves after the runtime has durably acknowledged the hook wakeup. */
  notify: (context: HookNotifyContext) => Promise<void>;
};

export type DurableHooksRun = {
  claimedCount: number;
  completion: Promise<number>;
};

export type DurableHooksRunner = {
  processDue: () => Promise<DurableHooksRun>;
  drain: () => Promise<void>;
};

/**
 * Configuration for hook processing.
 */
export interface HookProcessorConfig<THooks extends HooksMap = HooksMap> {
  hooks?: THooks;
  namespace: string;
  internalFragment: InternalFragmentInstance;
  handlerTx: HookHandlerTx;
  /**
   * Whether post-mutate notifications should auto-schedule processing.
   * Defaults to true.
   */
  autoSchedule?: boolean;
  /**
   * Internal hook runner used to coordinate processing/drain.
   */
  runner?: DurableHooksRunner;
  /**
   * Post-commit durable hooks notifier.
   */
  notifier?: HookNotifier;
  /**
   * Optional durable-hook context propagation and attempt instrumentation.
   */
  instrumentation?: DurableHooksInstrumentation;
  /** Database transaction instrumentation used for internal durable-hook storage operations. */
  transactionInstrumentation?: DatabaseTransactionInstrumentation;
  /**
   * Re-queue hooks that have been in `processing` for at least this many minutes.
   * Use `false` to disable stuck-processing recovery entirely.
   * Values <= 0 are treated as `false`.
   *
   * Default: 10 minutes.
   */
  stuckProcessingTimeoutMinutes?: StuckHookProcessingTimeoutMinutes;
  /**
   * Delete completed hooks once their last attempt is at least this many minutes old. Pending,
   * processing, and failed hooks are kept. A hook ID rejects duplicate triggers only while its hook
   * is kept. Use `false` to keep completed hooks forever. Values <= 0 are treated as `false`.
   *
   * Default: 7 days.
   */
  completedHookRetentionMinutes?: CompletedHookRetentionMinutes;
  /**
   * Called when stuck processing hooks are detected and re-queued.
   * Invoked after the hooks are moved back to `pending`.
   */
  onStuckProcessingHooks?: (info: StuckHookProcessingInfo) => void;
}

export type StuckHookProcessingTimeoutMinutes = number | false;

export type CompletedHookRetentionMinutes = number | false;

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
   * Delete completed hooks once their last attempt is at least this many minutes old. Pending,
   * processing, and failed hooks are kept. A hook ID rejects duplicate triggers only while its hook
   * is kept. Use `false` to keep completed hooks forever. Values <= 0 are treated as `false`.
   *
   * Default: 7 days.
   */
  completedHookRetentionMinutes?: CompletedHookRetentionMinutes;
  /**
   * Automatically schedule hook processing after successful mutations.
   * Defaults to true. Set false to disable auto scheduling (manual drain only).
   */
  autoSchedule?: boolean;
  /**
   * Called when stuck processing hooks are detected and re-queued.
   * Invoked after the hooks are moved back to `pending`.
   */
  onStuckProcessingHooks?: (info: StuckHookProcessingInfo) => void;
  /**
   * Durable hooks logging controls.
   * Defaults: enabled=true, level="warn" (level="error" during test execution).
   */
  logging?: DurableHooksLoggerConfig;
  /**
   * Optional durable-hook context propagation and attempt instrumentation.
   */
  instrumentation?: DurableHooksInstrumentation;
};

export type HookHandlerTx = (
  execOptions?: Omit<ExecuteTxOptions, "createUnitOfWork">,
) => HandlerTxBuilder<readonly [], [], [], unknown, unknown, false, false, false, false, HooksMap>;

const DEFAULT_STUCK_PROCESSING_TIMEOUT_MINUTES = 10;
const MAX_ACTIVE_DURABLE_HOOKS = 16;

const DEFAULT_COMPLETED_HOOK_RETENTION_MINUTES = 7 * 24 * 60;

function resolveCompletedHookRetentionMinutes(
  value: CompletedHookRetentionMinutes | undefined,
): number | false {
  if (value === false) {
    return false;
  }
  if (typeof value === "number") {
    return value > 0 ? value : false;
  }
  return DEFAULT_COMPLETED_HOOK_RETENTION_MINUTES;
}

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

function captureInstrumentedPropagationContext(
  info: DurableHookEnqueueInfo,
  instrumentation: DurableHooksInstrumentation | undefined,
  fallbackContext: DurableHookPropagationContext | null,
): DurableHookPropagationContext | null {
  if (!instrumentation) {
    return fallbackContext;
  }

  return instrumentation.captureContext(info) ?? fallbackContext;
}

async function runInstrumentedHookAttempt<T>(
  instrumentation: DurableHooksInstrumentation,
  attempt: DurableHookAttempt,
  execute: () => Promise<T>,
): Promise<T> {
  let executeCalls = 0;
  let execution: Promise<T> | undefined;
  let repeatedExecutionError: Error | undefined;
  let instrumentationSettled = false;

  const rejectExecution = (error: Error): Promise<T> => {
    const rejection = Promise.reject<T>(error);
    void rejection.catch(() => undefined);
    return rejection;
  };
  const executeOnce = (): Promise<T> => {
    if (instrumentationSettled) {
      return rejectExecution(
        new Error(
          `Durable hooks instrumentation called execute() after runAttempt() settled for hook '${attempt.hookName}' attempt ${attempt.attempt}.`,
        ),
      );
    }

    executeCalls += 1;
    if (executeCalls > 1) {
      repeatedExecutionError ??= new Error(
        `Durable hooks instrumentation called execute() more than once for hook '${attempt.hookName}' attempt ${attempt.attempt}.`,
      );
      return rejectExecution(repeatedExecutionError);
    }

    execution = Promise.resolve().then(execute);
    return execution;
  };

  let instrumentationRejected = false;
  let instrumentationError: unknown;
  try {
    await instrumentation.runAttempt(attempt, executeOnce);
  } catch (error) {
    instrumentationRejected = true;
    instrumentationError = error;
  } finally {
    instrumentationSettled = true;
  }

  if (!execution) {
    throw new Error(
      `Durable hooks instrumentation did not call execute() for hook '${attempt.hookName}' attempt ${attempt.attempt}.`,
      instrumentationRejected ? { cause: instrumentationError } : undefined,
    );
  }

  const executionResult = await execution.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );

  if (executeCalls !== 1) {
    throw (
      repeatedExecutionError ??
      new Error(
        `Durable hooks instrumentation violated the execute() contract for hook '${attempt.hookName}' attempt ${attempt.attempt}.`,
      )
    );
  }
  if (executionResult.status === "rejected") {
    throw executionResult.reason;
  }
  if (instrumentationRejected) {
    throw instrumentationError;
  }
  return executionResult.value;
}

function captureDurableHookPropagationContext(
  hook: TriggeredHook,
  idempotencyKey: string,
  instrumentation: DurableHooksInstrumentation | undefined,
  ambientContext: DurableHookPropagationContext | null,
): DurableHookPropagationContext | null {
  if (hook.options?.propagationContext !== undefined) {
    return hook.options.propagationContext;
  }

  return captureInstrumentedPropagationContext(
    {
      namespace: hook.namespace,
      hookName: hook.hookName,
      idempotencyKey,
    },
    instrumentation,
    ambientContext,
  );
}

/**
 * Add hook events as mutation operations to the UOW.
 * This should be called before executeMutations() so hook records are created
 * in the same transaction as the user's mutations.
 *
 * Each triggered hook carries its own namespace (set at trigger-time), so this
 * function works regardless of which fragment's handler is executing.
 */
export function prepareHookMutations(
  uow: Pick<IUnitOfWork, "getTriggeredHooks" | "forSchema" | "idempotencyKey">,
  internalFragment: InternalFragmentInstance,
  instrumentation?: DurableHooksInstrumentation,
  ambientContext: DurableHookPropagationContext | null = null,
): void {
  const triggeredHooks = uow.getTriggeredHooks();

  if (triggeredHooks.length === 0) {
    return;
  }

  const primaryNamespace = triggeredHooks[0]?.namespace;
  DurableHooksLogger.debug("Durable hooks queued", {
    namespace: primaryNamespace,
    fields: () => {
      const hookSummary = new Map<string, { namespace: string; hookName: string; count: number }>();
      for (const hook of triggeredHooks) {
        const key = `${hook.namespace}:${hook.hookName}`;
        const summary = hookSummary.get(key);
        if (summary) {
          summary.count += 1;
          continue;
        }
        hookSummary.set(key, {
          namespace: hook.namespace,
          hookName: hook.hookName,
          count: 1,
        });
      }
      const hooks = Array.from(hookSummary.values());
      return {
        hooks,
        total: triggeredHooks.length,
      };
    },
  });

  const internalUow = uow.forSchema(internalSchema);

  for (const hook of triggeredHooks) {
    // Hooks of another fragment's namespace are queued here too; its runtime knows their policy.
    // The processor records the policy it actually applies after each attempt.
    const maxAttempts = resolveDurableHookRetryPolicy(
      getDurableHooksRuntimeByNamespace(hook.namespace, internalFragment)?.config.hooks?.[
        hook.hookName
      ],
    ).maxAttempts;
    const rawProcessAt = hook.options?.processAt ?? null;
    const processAt: Date | DbNow | null =
      rawProcessAt === null ? null : isDbNow(rawProcessAt) ? rawProcessAt : new Date(rawProcessAt);
    const nextRetryAt = processAt ?? null;
    const propagationContext = captureDurableHookPropagationContext(
      hook,
      uow.idempotencyKey,
      instrumentation,
      ambientContext,
    );
    const hookValues = {
      ...(hook.options?.id !== undefined ? { id: hook.options.id } : {}),
      namespace: hook.namespace,
      hookName: hook.hookName,
      payload: hook.payload,
      status: "pending",
      attempts: 0,
      maxAttempts,
      lastAttemptAt: null,
      nextRetryAt,
      error: null,
      nonce: uow.idempotencyKey,
      propagationContext,
    };

    internalUow.create("fragno_hooks", hookValues);
  }
}

/**
 * Claim due hook events and start their attempts.
 */
export async function processHooks<THooks extends HooksMap>(
  config: HookProcessorConfig<THooks>,
  { claimLimit = MAX_ACTIVE_DURABLE_HOOKS }: { claimLimit?: number } = {},
): Promise<DurableHooksRun> {
  const { hooks, namespace, internalFragment } = config;
  if (!hooks) {
    throw new Error("Hook processor hooks not initialized.");
  }
  const stuckProcessingTimeoutMinutes = resolveStuckProcessingTimeoutMinutes(
    config.stuckProcessingTimeoutMinutes,
  );
  const includeStuckProcessing = stuckProcessingTimeoutMinutes !== false;
  const staleBefore = includeStuckProcessing
    ? dbNow().plus({ minutes: -stuckProcessingTimeoutMinutes })
    : null;
  const completedHookRetentionMinutes = resolveCompletedHookRetentionMinutes(
    config.completedHookRetentionMinutes,
  );
  const completedBefore =
    completedHookRetentionMinutes === false
      ? null
      : dbNow().plus({ minutes: -completedHookRetentionMinutes });
  let claimedEvents: Array<{
    id: FragnoId;
    hookName: string;
    payload: unknown;
    status: HookStatus;
    attempts: number;
    maxAttempts: number;
    idempotencyKey: string;
    propagationContext: DurableHookPropagationContext | null;
    lastAttemptAt: Date | null;
    nextRetryAt: Date | null;
    createdAt: Date;
  }> = [];
  let stuckEvents: StuckHookProcessingEvent[] = [];

  const result = await internalFragment.inContext(async function () {
    return await this.handlerTx({
      name: `internal.hooks.${namespace}.claimDue`,
      transactionInstrumentation: config.transactionInstrumentation,
    })
      .withServiceCalls(
        () =>
          [
            internalFragment.services.hookService.claimDueHookEvents(
              namespace,
              staleBefore,
              claimLimit,
              completedBefore,
            ),
          ] as const,
      )
      .transform(({ serviceResult: [claimResult] }) => claimResult)
      .execute();
  });

  const pendingCount = result.pendingCount;
  const stuckClaimedCount = result.stuckEvents.length;
  const stuckRequeuedCount = result.stuckEvents.length;
  const staleBeforeApprox = includeStuckProcessing
    ? new Date(Date.now() - stuckProcessingTimeoutMinutes * 60_000).toISOString()
    : null;
  DurableHooksLogger.debug("Durable hooks claimed", {
    namespace,
    fields: {
      pending: pendingCount,
      stuck: stuckClaimedCount,
      requeued: stuckRequeuedCount,
      includeStuckProcessing,
      staleBeforeApprox,
    },
  });

  claimedEvents = result.events.map((event) => ({
    ...event,
    status: assertHookStatus(event.status),
  }));
  stuckEvents = result.stuckEvents;

  if (includeStuckProcessing && stuckEvents.length > 0) {
    const info = {
      namespace,
      timeoutMinutes: stuckProcessingTimeoutMinutes,
      events: stuckEvents,
    };
    try {
      config.onStuckProcessingHooks?.(info);
    } catch (error) {
      DurableHooksLogger.error("Error calling onStuckProcessingHooks", {
        namespace,
        fields: {
          error: DurableHooksLogger.toErrorMessage(error),
        },
      });
    }
    try {
      config.instrumentation?.observeStuckProcessingHooks?.(info);
    } catch (error) {
      DurableHooksLogger.error("Error calling observeStuckProcessingHooks", {
        namespace,
        fields: {
          error: DurableHooksLogger.toErrorMessage(error),
        },
      });
    }
  }

  if (claimedEvents.length === 0) {
    DurableHooksLogger.debug("Durable hooks idle", {
      namespace,
    });
    return {
      claimedCount: 0,
      completion: Promise.resolve(0),
    };
  }

  const completion = (async () => {
    // Process events (async work outside transaction)
    const processedEvents = await Promise.allSettled(
      claimedEvents.map(async (event) => {
        const hookFn = hooks[event.hookName];
        const missingHookError = `Hook '${event.hookName}' not found in hooks map`;
        const retryPolicy = resolveDurableHookRetryPolicy(hookFn);
        const { maxAttempts } = retryPolicy;
        const attempt: DurableHookAttempt = {
          namespace,
          hookId: event.id,
          hookName: event.hookName,
          idempotencyKey: event.idempotencyKey,
          attempt: event.attempts + 1,
          maxAttempts,
          createdAt: event.createdAt,
          propagationContext: event.propagationContext,
        };

        try {
          const executeHook = async () => {
            if (!hookFn) {
              throw new Error(missingHookError);
            }

            const startedAt = Date.now();
            DurableHooksLogger.debug("Hook start", {
              namespace,
              fields: {
                eventId: event.id,
                hookName: event.hookName,
                status: event.status,
                attempts: event.attempts,
                maxAttempts,
                createdAt: event.createdAt.toISOString(),
                nextRetryAt: event.nextRetryAt ? event.nextRetryAt.toISOString() : null,
                lastAttemptAt: event.lastAttemptAt ? event.lastAttemptAt.toISOString() : null,
              },
            });
            const hookContext: HookContext = {
              idempotencyKey: event.idempotencyKey,
              hookId: event.id,
              hookName: event.hookName,
              status: event.status,
              attempts: event.attempts,
              maxAttempts,
              propagationContext: event.propagationContext,
              capturePropagationContext: () =>
                captureInstrumentedPropagationContext(
                  {
                    namespace,
                    hookName: event.hookName,
                    idempotencyKey: event.idempotencyKey,
                  },
                  config.instrumentation,
                  event.propagationContext,
                ),
              lastAttemptAt: event.lastAttemptAt,
              nextRetryAt: event.nextRetryAt,
              createdAt: event.createdAt,
              handlerTx: config.handlerTx,
            };
            await hookFn.call(hookContext, event.payload);
            DurableHooksLogger.debug("Hook completed", {
              namespace,
              fields: {
                eventId: event.id,
                hookName: event.hookName,
                ms: Date.now() - startedAt,
              },
            });
          };

          if (config.instrumentation) {
            await runInstrumentedHookAttempt(config.instrumentation, attempt, executeHook);
          } else {
            await executeHook();
          }

          return {
            eventId: event.id,
            attempt,
            status: "completed" as const,
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (!hookFn) {
            DurableHooksLogger.error("Hook missing", {
              namespace,
              fields: {
                eventId: event.id,
                hookName: event.hookName,
                attempts: event.attempts,
                maxAttempts,
                createdAt: event.createdAt.toISOString(),
              },
            });
          } else {
            DurableHooksLogger.error("Hook failed", {
              namespace,
              fields: {
                eventId: event.id.toJSON(),
                hookName: event.hookName,
                error: errorMessage,
                idempotencyKey: event.idempotencyKey,
              },
            });
          }
          return {
            eventId: event.id,
            attempt,
            status: "failed" as const,
            error,
            errorMessage,
            retryDelayMs: durableHookRetryDelayMs(retryPolicy, attempt.attempt, error),
          };
        }
      }),
    );

    // Mark events as completed/failed
    await internalFragment.inContext(async function () {
      await this.handlerTx({
        name: `internal.hooks.${namespace}.finalizeAttempts`,
        transactionInstrumentation: config.transactionInstrumentation,
      })
        .mutate(({ forSchema }) => {
          const uow = forSchema(internalSchema);
          const now = dbNow();

          for (const processedEvent of processedEvents) {
            if (processedEvent.status === "rejected") {
              DurableHooksLogger.error("Hook processing promise rejected", {
                namespace,
                fields: {
                  error: DurableHooksLogger.toErrorMessage(processedEvent.reason),
                },
              });
              continue;
            }

            const processed = processedEvent.value;

            if (processed.status === "completed") {
              uow.update("fragno_hooks", processed.eventId, (b) =>
                b.set({ status: "completed", lastAttemptAt: now }).check(),
              );
              continue;
            }

            const { eventId, attempt, errorMessage, retryDelayMs } = processed;
            const attempts = attempt.attempt;
            const maxAttempts = attempt.maxAttempts;
            uow.update("fragno_hooks", eventId, (b) =>
              b
                .set(
                  retryDelayMs === null
                    ? {
                        status: "failed",
                        attempts,
                        maxAttempts,
                        lastAttemptAt: now,
                        error: errorMessage,
                      }
                    : {
                        status: "pending",
                        attempts,
                        maxAttempts,
                        lastAttemptAt: now,
                        nextRetryAt: now.plus({ ms: retryDelayMs }),
                        error: errorMessage,
                      },
                )
                .check(),
            );
          }
        })
        .execute();
    });

    const { instrumentation } = config;
    if (instrumentation?.observeAttemptOutcome) {
      for (const processedEvent of processedEvents) {
        if (processedEvent.status === "rejected") {
          continue;
        }
        const processed = processedEvent.value;
        const outcome: DurableHookAttemptOutcome =
          processed.status === "completed"
            ? { status: "completed" }
            : processed.retryDelayMs === null
              ? { status: "failed", error: processed.error }
              : { status: "retry-scheduled", error: processed.error };
        try {
          instrumentation.observeAttemptOutcome(processed.attempt, outcome);
        } catch (error) {
          DurableHooksLogger.error("Durable hooks attempt outcome observer failed", {
            namespace,
            fields: {
              hookName: processed.attempt.hookName,
              error: DurableHooksLogger.toErrorMessage(error),
            },
          });
        }
      }
    }

    const processedCount = processedEvents.reduce(
      (count, result) => count + (result.status === "fulfilled" ? 1 : 0),
      0,
    );

    const failed = processedEvents.flatMap((result) =>
      result.status === "fulfilled" && result.value.status === "failed"
        ? [{ eventId: result.value.eventId, error: result.value.errorMessage }]
        : [],
    );

    DurableHooksLogger.debug("Durable hooks processed", {
      namespace,
      fields: {
        processed: processedCount,
        failed: failed.length,
        failures: failed.length > 0 ? failed : null,
      },
    });

    return processedCount;
  })();

  return {
    claimedCount: claimedEvents.length,
    completion,
  };
}

export function createDurableHooksRunner(config: HookProcessorConfig): DurableHooksRunner {
  const activeCompletions = new Set<Promise<number>>();
  let activeHookCount = 0;
  let claimQueue = Promise.resolve();

  const waitForHookCapacity = async () => {
    while (activeHookCount >= MAX_ACTIVE_DURABLE_HOOKS) {
      await Promise.race(activeCompletions).catch(() => undefined);
    }
  };

  const processDue = (): Promise<DurableHooksRun> => {
    const runPromise = claimQueue.then(async () => {
      await waitForHookCapacity();

      const availableCapacity = MAX_ACTIVE_DURABLE_HOOKS - activeHookCount;
      const run = await processHooks(config, { claimLimit: availableCapacity });
      if (run.claimedCount === 0) {
        return run;
      }

      activeHookCount += run.claimedCount;
      const completion = run.completion.finally(() => {
        activeHookCount -= run.claimedCount;
        activeCompletions.delete(completion);
      });
      activeCompletions.add(completion);

      return {
        claimedCount: run.claimedCount,
        completion,
      };
    });
    claimQueue = runPromise.then(
      () => undefined,
      () => undefined,
    );

    return runPromise;
  };

  const drain = async () => {
    while (true) {
      const run = await processDue();
      if (run.claimedCount > 0) {
        await run.completion;
        continue;
      }

      if (activeCompletions.size === 0) {
        return;
      }

      await Promise.all(activeCompletions);
    }
  };

  return { processDue, drain };
}
