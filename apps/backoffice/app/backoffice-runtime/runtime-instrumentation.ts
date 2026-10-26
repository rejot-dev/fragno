import type {
  FragmentDurableObjectInitializationContext,
  FragmentDurableObjectInitializationInstrumentation,
} from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import type { DurableHookAttempt, DurableHooksInstrumentation } from "@fragno-dev/db/hooks";
import type {
  DatabaseTransactionInstrumentation,
  DatabaseTransactionInstrumentationContext,
} from "@fragno-dev/db/transaction-instrumentation";

import type { BackofficeScopeFields } from "./backoffice-telemetry";

/** A point after which an object's writes so far should become durable. */
export type BackofficeStorageConfirmation =
  | { event: "codemode.run_started"; runId: string }
  | { event: "automations.alarm_returned"; handlerDurationMs: number };

/** Supplies runtime-specific tracing for one object's Fragment and durable-hook operations. */
export type BackofficeRuntimeInstrumentation = {
  databaseTransactions: DatabaseTransactionInstrumentation;
  durableHooks: DurableHooksInstrumentation;
  fragmentInitialization: FragmentDurableObjectInitializationInstrumentation;
  /** Observes, without waiting, when the object's writes so far become durable. */
  storageConfirmation: (
    storage: DurableObjectStorage,
    confirmation: BackofficeStorageConfirmation,
  ) => void;
};

/** Returns the stable span name for one named Fragno database transaction or callback. */
export function backofficeDatabaseTransactionSpanName(
  context: DatabaseTransactionInstrumentationContext,
): string {
  const transactionName = context.transactionName ?? "(anonymous)";
  return context.callback
    ? `fragno.db.${context.transactionKind}.${transactionName}.${context.callback}`
    : `fragno.db.${context.transactionKind}.${transactionName}`;
}

/** Returns the stable span name for one Fragment runtime initialization phase. */
export function backofficeFragmentInitializationSpanName(
  context: FragmentDurableObjectInitializationContext,
): string {
  return context.phase === "createRuntime"
    ? "fragno.fragment_runtime.create"
    : "fragno.fragment.migrate";
}

/** Returns searchable lifecycle fields shared by durable-hook attempt spans and logs. */
export function backofficeDurableHookAttemptFields(attempt: DurableHookAttempt) {
  return {
    namespace: attempt.namespace,
    hookName: attempt.hookName,
    hookId: attempt.hookId.toString(),
    correlationId: attempt.idempotencyKey,
    attempt: attempt.attempt,
    maxAttempts: attempt.maxAttempts,
    hasPropagationContext: attempt.propagationContext !== null,
  };
}

function backofficeInstrumentationErrorFields(error: unknown) {
  return error instanceof Error
    ? { errorName: error.name, errorMessage: error.message }
    : { errorName: "UnknownError", errorMessage: String(error) };
}

/** Executes one durable hook attempt with the canonical Backoffice lifecycle logs. */
export async function executeLoggedBackofficeDurableHookAttempt<T>(
  attempt: DurableHookAttempt,
  scope: BackofficeScopeFields,
  execute: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const fields = { ...backofficeDurableHookAttemptFields(attempt), ...scope };
  console.info("fragno.durable_hook.attempt.started", fields);

  try {
    const result = await execute();
    console.info("fragno.durable_hook.attempt.completed", {
      ...fields,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    console.error("fragno.durable_hook.attempt.failed", {
      ...fields,
      durationMs: Date.now() - startedAt,
      ...backofficeInstrumentationErrorFields(error),
    });
    throw error;
  }
}
