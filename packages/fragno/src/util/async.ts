type SubscribeFn<T> = (callback: (value: T) => void) => UnsubscribeFn | void;
type UnsubscribeFn = () => void;

/**
 * Creates an async iterator from a subscribe function that follows the observable pattern.
 *
 * @template T The type of values produced by the store.
 * @param subscribe A function that subscribes to store updates. It receives a callback to be
 *          called on each update, and returns an unsubscribe function.
 * @returns An async generator that yields store values as they are produced.
 */
export function createAsyncIteratorFromCallback<T>(
  subscribe: SubscribeFn<T>,
): AsyncGenerator<T, void, unknown> {
  const queue: T[] = [];
  let unsubscribe: UnsubscribeFn | null = null;
  let resolveNext: ((value: IteratorResult<T>) => void) | null = null;

  const unsubscribeFunc = subscribe((value) => {
    if (resolveNext) {
      // If there's a pending promise, resolve it immediately
      resolveNext({ value, done: false });
      resolveNext = null;
    } else {
      // Otherwise, queue the value
      queue.push(value);
    }
  });

  // Store unsubscribe function if one was returned
  if (typeof unsubscribeFunc === "function") {
    unsubscribe = unsubscribeFunc;
  }

  return (async function* () {
    try {
      while (true) {
        if (queue.length > 0) {
          // Yield queued values
          yield queue.shift()!;
        } else {
          // Wait for the next value
          yield await new Promise<T>((resolve) => {
            resolveNext = (result) => {
              if (!result.done) {
                resolve(result.value);
              }
            };
          });
        }
      }
    } finally {
      // Clean up subscription on iterator termination
      if (unsubscribe) {
        unsubscribe();
      }
    }
  })();
}

/**
 * Waits for an async iterator to yield a value that meets a condition.
 *
 * @template T The type of values produced by the iterator.
 * @param iterable The async iterable to wait for.
 * @param condition A function that checks if a value meets the condition.
 * @param options Optional configuration options.
 * @returns A promise that resolves to the first value that meets the condition.
 */
export async function waitForAsyncIterator<T>(
  iterable: AsyncIterable<T>,
  condition: (value: T) => boolean,
  options: { timeout?: number } = {},
): Promise<T> {
  const { timeout = 1000 } = options;

  // Create a timeout promise that rejects after the specified time
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`waitForAsyncIterator: Timeout after ${timeout}ms`));
    }, timeout);
  });

  // Create a promise that resolves when the condition is met
  const iteratorPromise = (async () => {
    for await (const value of iterable) {
      if (condition(value)) {
        return value;
      }
    }
    throw new Error("waitForAsyncIterator: Iterator completed without meeting condition");
  })();

  // Race between the timeout and the iterator
  return Promise.race([iteratorPromise, timeoutPromise]);
}
