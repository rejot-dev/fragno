// Shared utilities for runner helpers.

import type { AnyTxResult } from "../workflow";
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
 * Check that a TxResult is mutate-only (no retrieve phase, no nested service calls).
 * Bigger picture: the runner does a single retrieve, so extra retrieve phases are forbidden.
 */
export function isMutateOnlyTx(tx: AnyTxResult): boolean {
  const { callbacks, serviceCalls } = tx._internal;
  if (callbacks.retrieve || callbacks.retrieveSuccess) {
    return false;
  }
  if (serviceCalls && serviceCalls.length > 0) {
    return false;
  }
  return true;
}
