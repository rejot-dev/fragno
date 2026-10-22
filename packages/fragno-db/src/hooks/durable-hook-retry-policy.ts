/**
 * How a durable hook retries a failed attempt. Each hook definition owns its policy and the
 * processor applies it after every failed attempt, so a changed policy also governs hooks that
 * were queued before the change.
 */
export type DurableHookRetryPolicy = {
  /** Attempts in total, the first one included. */
  maxAttempts: number;
  /** Delay after the first failed attempt; each later failure multiplies it by `backoffMultiplier`. */
  initialDelayMs: number;
  backoffMultiplier: number;
  /** Ceiling on the delay between two attempts. */
  maxDelayMs: number;
  /**
   * Whether another attempt could succeed after `error`. An error no retry can fix, such as
   * invalid input or a denied permission, fails the hook at once instead of using up its attempts.
   */
  isRetryable: (error: unknown) => boolean;
};

/**
 * Retries for roughly half an hour to fifty minutes, long enough to outlast the restart or deploy
 * of a dependency the hook calls.
 */
export const defaultDurableHookRetryPolicy: DurableHookRetryPolicy = {
  maxAttempts: 10,
  initialDelayMs: 1_000,
  backoffMultiplier: 3,
  maxDelayMs: 15 * 60_000,
  isRetryable: () => true,
};

export function assertDurableHookRetryPolicy(policy: DurableHookRetryPolicy): void {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new Error(
      `Durable hook retry policy needs a whole number of maxAttempts of at least 1, got ${policy.maxAttempts}.`,
    );
  }
  if (policy.initialDelayMs < 0 || policy.maxDelayMs < policy.initialDelayMs) {
    throw new Error(
      "Durable hook retry policy needs 0 <= initialDelayMs <= maxDelayMs, got " +
        `initialDelayMs=${policy.initialDelayMs} and maxDelayMs=${policy.maxDelayMs}.`,
    );
  }
  if (policy.backoffMultiplier < 1) {
    throw new Error(
      `Durable hook retry policy needs a backoffMultiplier of at least 1, got ${policy.backoffMultiplier}.`,
    );
  }
}

/**
 * The delay before the next attempt, or null when the hook has failed for good. The delay is drawn
 * from the upper half of the backoff, so hooks that failed together against one dependency do not
 * all retry at the same moment.
 */
export function durableHookRetryDelayMs(
  policy: DurableHookRetryPolicy,
  failedAttempts: number,
  error: unknown,
): number | null {
  if (failedAttempts >= policy.maxAttempts || !policy.isRetryable(error)) {
    return null;
  }
  const backoffMs = Math.min(
    policy.initialDelayMs * policy.backoffMultiplier ** (failedAttempts - 1),
    policy.maxDelayMs,
  );
  return Math.round(backoffMs / 2 + Math.random() * (backoffMs / 2));
}
