import { AsyncLocalStorage } from "node:async_hooks";

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
  #storage: AsyncLocalStorage<TRequestStorage>;

  constructor() {
    this.#storage = new AsyncLocalStorage<TRequestStorage>();
  }

  /**
   * Run a callback with the given data available via getStore().
   * This establishes the async context for the duration of the callback.
   */
  run<T>(data: TRequestStorage, callback: () => T): T;
  run<T>(data: TRequestStorage, callback: () => Promise<T>): Promise<T>;
  run<T>(data: TRequestStorage, callback: () => T | Promise<T>): T | Promise<T> {
    return this.#storage.run(data, callback);
  }

  /**
   * Check whether a store is currently active.
   */
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
    const store = this.#storage.getStore();
    if (!store) {
      throw new Error(
        "No storage found in RequestContextStorage. Service must be called within a route handler OR using `inContext`.",
      );
    }
    return store;
  }

  /**
   * Enter a new async context with fresh storage.
   * This is typically called at the start of a request handler.
   *
   * @param initializer Function that returns the initial storage data
   * @param callback The request handler to execute with the storage
   */
  runWithInitializer<T>(initializer: () => TRequestStorage, callback: () => T): T;
  runWithInitializer<T>(initializer: () => TRequestStorage, callback: () => Promise<T>): Promise<T>;
  runWithInitializer<T>(
    initializer: () => TRequestStorage,
    callback: () => T | Promise<T>,
  ): T | Promise<T> {
    const data = initializer();
    return this.#storage.run(data, callback);
  }
}
