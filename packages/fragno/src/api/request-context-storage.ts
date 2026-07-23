import { AsyncLocalStorage } from "node:async_hooks";

export type RequestPropagationContext = Readonly<Record<string, string>>;

export function extractW3CRequestPropagationContext(
  headers: Headers,
): RequestPropagationContext | null {
  const traceparent = headers.get("traceparent");
  if (!traceparent) {
    return null;
  }

  const tracestate = headers.get("tracestate");
  return tracestate ? { traceparent, tracestate } : { traceparent };
}

type RequestContext<TRequestStorage> = {
  storage: TRequestStorage;
  propagationContext: RequestPropagationContext | null;
};

type RunOptions = {
  /** Omit to inherit the active carrier. Use `null` to suppress propagation. */
  propagationContext?: RequestPropagationContext | null;
};

/**
 * Typed wrapper around AsyncLocalStorage for managing per-request data storage.
 * Each fragment instance has its own storage to ensure proper isolation.
 *
 * TRequestStorage represents the type of data stored per-request (e.g., { userId: string, requestId: number })
 *
 * Note: The data stored should be an object that can be mutated during the request lifecycle.
 * For example, you can store { uow: UnitOfWork } and modify properties on that object.
 *
 * @internal - Used by @fragno-dev/db, not part of public API
 */
export class RequestContextStorage<TRequestStorage> {
  readonly #storage = new AsyncLocalStorage<RequestContext<TRequestStorage>>();

  /**
   * Run a callback with the given data available via getStore().
   * This establishes the async context for the duration of the callback.
   */
  run<T>(data: TRequestStorage, callback: () => T, options: RunOptions = {}): T {
    const propagationContext =
      options.propagationContext === undefined
        ? (this.#storage.getStore()?.propagationContext ?? null)
        : options.propagationContext;

    return this.#storage.run({ storage: data, propagationContext }, callback);
  }

  /** Check whether a store is currently active. */
  hasStore(): boolean {
    return this.#storage.getStore() !== undefined;
  }

  /**
   * Get the current stored data from AsyncLocalStorage.
   * @throws an error if called outside of a run() callback.
   *
   * Note: The returned object can be mutated. Changes will be visible to all code
   * running within the same async context.
   */
  getStore(): TRequestStorage {
    return this.#getContext().storage;
  }

  /** Get the propagation carrier associated with the current execution. */
  getPropagationContext(): RequestPropagationContext | null {
    return this.#getContext().propagationContext;
  }

  /** Enter a new async context with freshly initialized storage. */
  runWithInitializer<T>(
    initializer: () => TRequestStorage,
    callback: () => T,
    options?: RunOptions,
  ): T {
    return this.run(initializer(), callback, options);
  }

  #getContext(): RequestContext<TRequestStorage> {
    const context = this.#storage.getStore();
    if (!context) {
      throw new Error(
        "No storage found in RequestContextStorage. Service must be called within a route handler OR using `inContext`.",
      );
    }
    return context;
  }
}
