/**
 * Adapted from Kysely's RuntimeDriver
 * Modified from: https://github.com/kysely-org/kysely
 * License: MIT
 * Copyright (c) 2022 Sami Koskimäki
 */

import type { DatabaseConnection, Driver, TransactionSettings } from "../sql-driver";

const normalizeError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/**
 * A small wrapper around {@link Driver} that makes sure the driver is
 * initialized before it is used, only initialized and destroyed
 * once etc.
 */
export class RuntimeDriver implements Driver {
  readonly #driver: Driver;

  #initPromise?: Promise<void>;
  #initDone: boolean;
  #destroyPromise?: Promise<void>;

  constructor(driver: Driver) {
    this.#initDone = false;
    this.#driver = driver;
  }

  async init(): Promise<void> {
    if (this.#destroyPromise) {
      throw new Error("driver has already been destroyed");
    }

    if (!this.#initPromise) {
      this.#initPromise = this.#driver
        .init()
        .then(() => {
          this.#initDone = true;
        })
        .catch((error: unknown) => {
          this.#initPromise = undefined;
          throw normalizeError(error);
        });
    }

    await this.#initPromise;
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    if (this.#destroyPromise) {
      throw new Error("driver has already been destroyed");
    }

    if (!this.#initDone) {
      await this.init();
    }

    return await this.#driver.acquireConnection();
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    await this.#driver.releaseConnection(connection);
  }

  beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    return this.#driver.beginTransaction(connection, settings);
  }

  commitTransaction(connection: DatabaseConnection): Promise<void> {
    return this.#driver.commitTransaction(connection);
  }

  rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    return this.#driver.rollbackTransaction(connection);
  }

  async destroy(): Promise<void> {
    if (!this.#initPromise) {
      return;
    }

    await this.#initPromise;

    if (!this.#destroyPromise) {
      this.#destroyPromise = this.#driver.destroy().catch((error: unknown) => {
        this.#destroyPromise = undefined;
        throw normalizeError(error);
      });
    }

    await this.#destroyPromise;
  }
}
