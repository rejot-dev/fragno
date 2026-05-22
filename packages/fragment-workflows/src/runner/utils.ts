// Shared utilities for runner helpers.

import type { AnyTxResult } from "../workflow";

export const NESTED_STEP_SEPARATOR = ">";

export function buildNestedStepKey(parentStepKey: string, childStepKey: string): string {
  return `${parentStepKey}${NESTED_STEP_SEPARATOR}${childStepKey}`;
}

export function getOutermostStepKey(stepKey: string): string {
  return stepKey.split(NESTED_STEP_SEPARATOR)[0]!;
}
import { NonRetryableError } from "../workflow";

/**
 * Normalize thrown values into a real Error instance.
 * Bigger picture: runner persists errors consistently regardless of throw type.
 */
export function toError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(typeof error === "string" ? error : "UNKNOWN_ERROR");
}

/**
 * Detect errors that should bypass step retries.
 * Bigger picture: NonRetryableError stops step retry loops for explicit user intent.
 */
export function isNonRetryableError(error: unknown): boolean {
  if (error instanceof NonRetryableError) {
    return true;
  }
  if (error && typeof error === "object" && "name" in error) {
    return (error as { name?: unknown }).name === "NonRetryableError";
  }
  return false;
}

/**
 * Check that a TxResult and any nested service calls are mutate-only.
 * Bigger picture: the runner does a single retrieve, so extra retrieve phases are forbidden.
 */
export function isMutateOnlyTx(tx: AnyTxResult): boolean {
  const { callbacks, serviceCalls } = tx._internal;
  if (callbacks.retrieve || callbacks.retrieveSuccess) {
    return false;
  }
  return !serviceCalls || serviceCalls.every(isMutateOnlyTx);
}
