import type { RetryPolicy } from "../query/unit-of-work/retry-policy";
import { ExponentialBackoffRetryPolicy } from "../query/unit-of-work/retry-policy";
import type { IUnitOfWork } from "../query/unit-of-work/unit-of-work";
import type { InternalFragmentInstance } from "../fragments/internal-fragment";

/**
 * Context available in hook functions via `this`.
 * Contains the nonce for idempotency and database access.
 */
export interface HookContext {
  /**
   * Unique nonce for this transaction.
   * Use this for idempotency checks in your hook implementation.
   */
  nonce: string;
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

/**
 * Configuration for hook processing.
 */
export interface HookProcessorConfig {
  hooks: HooksMap;
  namespace: string;
  internalFragment: InternalFragmentInstance;
  defaultRetryPolicy?: RetryPolicy;
}

/**
 * Add hook events as mutation operations to the UOW.
 * This should be called before executeMutations() so hook records are created
 * in the same transaction as the user's mutations.
 */
export function prepareHookMutations(uow: IUnitOfWork, config: HookProcessorConfig): void {
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
    internalUow.create("fragno_hooks", {
      namespace,
      hookName: hook.hookName,
      payload: hook.payload,
      status: "pending",
      attempts: 0,
      maxAttempts,
      lastAttemptAt: null,
      nextRetryAt: null,
      error: null,
      nonce: uow.nonce,
    });
  }
}

/**
 * Process pending hook events after the transaction has committed.
 * This should be called in the onSuccess callback after executeMutations().
 */
export async function processHooks(config: HookProcessorConfig): Promise<void> {
  const { hooks, namespace, internalFragment, defaultRetryPolicy } = config;
  const retryPolicy = defaultRetryPolicy ?? new ExponentialBackoffRetryPolicy({ maxRetries: 5 });

  await internalFragment.inContext(async function () {
    return await this.uow(async ({ executeRetrieve, executeMutate }) => {
      const pendingEventsPromise =
        internalFragment.services.hookService.getPendingHookEvents(namespace);
      await executeRetrieve();

      const pendingEvents = await pendingEventsPromise;

      if (pendingEvents.length === 0) {
        return;
      }

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
            const hookContext: HookContext = { nonce: event.nonce };
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

      for (const processedEvent of processedEvents) {
        if (processedEvent.status === "rejected") {
          continue;
        }

        const { eventId, status } = processedEvent.value;

        if (status === "completed") {
          internalFragment.services.hookService.markHookCompleted(eventId);
        } else if (status === "failed") {
          const { error, attempts } = processedEvent.value;
          internalFragment.services.hookService.markHookFailed(
            eventId,
            error,
            attempts,
            retryPolicy,
          );
        }
      }

      await executeMutate();
    });
  });
}
