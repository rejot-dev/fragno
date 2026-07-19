/**
 * Adapted from Kysely's SingleConnectionProvider
 * Modified from: https://github.com/kysely-org/kysely
 * License: MIT
 * Copyright (c) 2022 Sami Koskimäki
 */

import type { DatabaseConnection } from "../sql-driver";
import type { ConnectionProvider } from "./connection-provider";

const ignoreError = () => {};

export class SingleConnectionProvider implements ConnectionProvider {
  readonly #connection: DatabaseConnection;
  #runningPromise?: Promise<unknown>;

  constructor(connection: DatabaseConnection) {
    this.#connection = connection;
  }

  async provideConnection<T>(consumer: (connection: DatabaseConnection) => Promise<T>): Promise<T> {
    while (this.#runningPromise) {
      await this.#runningPromise.catch(ignoreError);
    }

    // `#runningPromise` must be set to undefined before it's
    // resolved or rejected. Otherwise the while loop above
    // will misbehave.
    const runningPromise = this.#run(consumer).finally(() => {
      this.#runningPromise = undefined;
    });
    this.#runningPromise = runningPromise;

    return runningPromise;
  }

  // Run the runner in an async function to make sure it doesn't
  // throw synchronous errors.
  async #run<T>(runner: (connection: DatabaseConnection) => Promise<T>): Promise<T> {
    return await runner(this.#connection);
  }
}
