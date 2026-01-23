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
