// Small helpers for timeouts and retry backoff.

import type { WorkflowDuration, WorkflowStepConfig } from "../workflow";
import { parseDurationMs } from "../utils";
import { DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS, MIN_WAIT_TIMEOUT_MS } from "./constants";

export const normalizeWaitTimeoutMs = (duration?: WorkflowDuration) => {
  const timeoutMs = duration ? parseDurationMs(duration) : DEFAULT_WAIT_TIMEOUT_MS;
  if (timeoutMs < MIN_WAIT_TIMEOUT_MS || timeoutMs > MAX_WAIT_TIMEOUT_MS) {
    throw new Error("WAIT_FOR_EVENT_TIMEOUT_RANGE");
  }
  return timeoutMs;
};

export const normalizeRetryConfig = (config?: WorkflowStepConfig) => {
  const retries = config?.retries;
  if (!retries) {
    return {
      maxAttempts: 1,
      delayMs: 0,
      backoff: "constant" as const,
    };
  }

  return {
    maxAttempts: retries.limit + 1,
    delayMs: parseDurationMs(retries.delay),
    backoff: retries.backoff ?? "constant",
  };
};

export const computeRetryDelayMs = (attempt: number, delayMs: number, backoff: string) => {
  if (delayMs === 0) {
    return 0;
  }

  switch (backoff) {
    case "linear":
      return delayMs * attempt;
    case "exponential":
      return delayMs * Math.pow(2, attempt - 1);
    default:
      return delayMs;
  }
};

export const isUniqueConstraintError = (error: unknown, seen = new Set<unknown>()): boolean => {
  if (seen.has(error)) {
    return false;
  }
  seen.add(error);

  if (!error || typeof error !== "object") {
    return false;
  }

  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string") {
    const normalized = code.toUpperCase();
    if (
      normalized === "23505" ||
      normalized === "SQLITE_CONSTRAINT" ||
      normalized === "SQLITE_CONSTRAINT_UNIQUE" ||
      normalized === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
      normalized === "ER_DUP_ENTRY" ||
      normalized === "1062"
    ) {
      return true;
    }
  }

  const name = "name" in error ? (error as { name?: unknown }).name : undefined;
  if (typeof name === "string" && name === "UniqueConstraintError") {
    return true;
  }

  const message = "message" in error ? (error as { message?: unknown }).message : undefined;
  if (typeof message === "string") {
    const normalized = message.toLowerCase();
    if (
      normalized.includes("unique constraint") ||
      normalized.includes("unique constraint failed") ||
      normalized.includes("duplicate key") ||
      normalized.includes("duplicate entry") ||
      normalized.includes("unique violation")
    ) {
      return true;
    }
  }

  if ("cause" in error && (error as { cause?: unknown }).cause) {
    if (isUniqueConstraintError((error as { cause?: unknown }).cause, seen)) {
      return true;
    }
  }

  if (error instanceof AggregateError) {
    for (const inner of error.errors) {
      if (isUniqueConstraintError(inner, seen)) {
        return true;
      }
    }
  }

  return false;
};
