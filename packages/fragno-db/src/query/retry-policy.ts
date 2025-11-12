/**
 * Policy for retrying failed Unit of Work operations
 */
export interface RetryPolicy {
  /**
   * Determines if the operation should be retried
   * @param attempt - The current attempt number (0-indexed)
   * @param error - Optional error from the previous attempt
   * @param signal - Optional AbortSignal to check for cancellation
   * @returns true if the operation should be retried, false otherwise
   */
  shouldRetry(attempt: number, error?: unknown, signal?: AbortSignal): boolean;

  /**
   * Gets the delay in milliseconds before the next retry attempt
   * @param attempt - The current attempt number (0-indexed)
   * @returns Delay in milliseconds
   */
  getDelayMs(attempt: number): number;
}

/**
 * Options for exponential backoff retry policy
 */
export interface ExponentialBackoffRetryPolicyOptions {
  /**
   * Maximum number of retry attempts (default: 3)
   */
  maxRetries?: number;

  /**
   * Initial delay in milliseconds (default: 100)
   */
  initialDelayMs?: number;

  /**
   * Maximum delay in milliseconds (default: 10000)
   */
  maxDelayMs?: number;

  /**
   * Multiplier for exponential backoff (default: 2)
   */
  backoffMultiplier?: number;
}

/**
 * Exponential backoff retry policy
 * Delay increases exponentially: initialDelay * (multiplier ^ attempt)
 */
export class ExponentialBackoffRetryPolicy implements RetryPolicy {
  readonly #maxRetries: number;
  readonly #initialDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #backoffMultiplier: number;

  constructor(options: ExponentialBackoffRetryPolicyOptions = {}) {
    this.#maxRetries = options.maxRetries ?? 3;
    this.#initialDelayMs = options.initialDelayMs ?? 100;
    this.#maxDelayMs = options.maxDelayMs ?? 10000;
    this.#backoffMultiplier = options.backoffMultiplier ?? 2;
  }

  shouldRetry(attempt: number, _error?: unknown, signal?: AbortSignal): boolean {
    // Check if operation was aborted
    if (signal?.aborted) {
      return false;
    }

    // Check if we've exceeded max retries
    return attempt < this.#maxRetries;
  }

  getDelayMs(attempt: number): number {
    const delay = this.#initialDelayMs * Math.pow(this.#backoffMultiplier, attempt);
    return Math.min(delay, this.#maxDelayMs);
  }
}

/**
 * Options for linear backoff retry policy
 */
export interface LinearBackoffRetryPolicyOptions {
  /**
   * Maximum number of retry attempts (default: 3)
   */
  maxRetries?: number;

  /**
   * Base delay in milliseconds (default: 100)
   */
  delayMs?: number;

  /**
   * Increment added to delay for each attempt in milliseconds (default: 100)
   */
  incrementMs?: number;
}

/**
 * Linear backoff retry policy
 * Delay increases linearly: delayMs + (attempt * incrementMs)
 */
export class LinearBackoffRetryPolicy implements RetryPolicy {
  readonly #maxRetries: number;
  readonly #delayMs: number;
  readonly #incrementMs: number;

  constructor(options: LinearBackoffRetryPolicyOptions = {}) {
    this.#maxRetries = options.maxRetries ?? 3;
    this.#delayMs = options.delayMs ?? 100;
    this.#incrementMs = options.incrementMs ?? 100;
  }

  shouldRetry(attempt: number, _error?: unknown, signal?: AbortSignal): boolean {
    // Check if operation was aborted
    if (signal?.aborted) {
      return false;
    }

    // Check if we've exceeded max retries
    return attempt < this.#maxRetries;
  }

  getDelayMs(attempt: number): number {
    return this.#delayMs + attempt * this.#incrementMs;
  }
}

/**
 * No retry policy - never retries failed operations
 */
export class NoRetryPolicy implements RetryPolicy {
  shouldRetry(_attempt: number, _error?: unknown, _signal?: AbortSignal): boolean {
    return false;
  }

  getDelayMs(_attempt: number): number {
    return 0;
  }
}
