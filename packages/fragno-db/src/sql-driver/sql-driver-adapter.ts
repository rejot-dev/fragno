/**
 * Adapted from Kysely patterns
 * Modified from: https://github.com/kysely-org/kysely
 * License: MIT
 * Copyright (c) 2022 Sami Koskimäki
 */

import type { CompiledQuery, Dialect, QueryResult } from "./sql-driver";
import { DefaultConnectionProvider } from "./connection/connection-provider";
import { SingleConnectionProvider } from "./connection/single-connection-provider";
import { RuntimeDriver } from "./driver/runtime-driver";
import type { GenericSQLPlugin } from "./query-executor/plugin";
import type { QueryExecutor } from "./query-executor/query-executor";
import { DefaultQueryExecutor } from "./query-executor/default-query-executor";

export class GenericSQLAdapter {
  readonly #dialect: Dialect;
  readonly #driver: RuntimeDriver | null;
  readonly #executor: QueryExecutor;

  constructor(dialect: Dialect);
  constructor(dialect: Dialect, executor: QueryExecutor, driver: RuntimeDriver | null);
  constructor(dialect: Dialect, executor?: QueryExecutor, driver?: RuntimeDriver | null) {
    this.#dialect = dialect;

    if (executor) {
      this.#driver = driver ?? null;
      this.#executor = executor;
    } else {
      const rawDriver = dialect.createDriver();
      const runtimeDriver = new RuntimeDriver(rawDriver);
      const connectionProvider = new DefaultConnectionProvider(runtimeDriver);
      this.#driver = runtimeDriver;
      this.#executor = new DefaultQueryExecutor(connectionProvider);
    }
  }

  async executeQuery(query: CompiledQuery): Promise<QueryResult<unknown>> {
    return await this.#executor.executeQuery(query);
  }

  async transaction<T>(callback: (trx: GenericSQLAdapter) => Promise<T>): Promise<T> {
    if (this.#driver === null) {
      throw new Error("Cannot start transaction: adapter was created with custom executor");
    }

    const driver = this.#driver;

    return await this.#executor.provideConnection(async (connection) => {
      const singleConnectionProvider = new SingleConnectionProvider(connection);
      const transactionExecutor = this.#executor.withConnectionProvider(singleConnectionProvider);
      const transactionAdapter = new GenericSQLAdapter(this.#dialect, transactionExecutor, driver);

      let transactionBegun = false;
      try {
        await driver.beginTransaction(connection, {});
        transactionBegun = true;

        const result = await callback(transactionAdapter);

        await driver.commitTransaction(connection);

        return result;
      } catch (error) {
        if (transactionBegun) {
          await driver.rollbackTransaction(connection);
        }

        throw error;
      }
    });
  }

  /**
   * Returns a copy of this adapter with the given plugin installed.
   */
  withPlugin(plugin: GenericSQLPlugin): GenericSQLAdapter {
    return new GenericSQLAdapter(this.#dialect, this.#executor.withPlugin(plugin), this.#driver);
  }

  /**
   * Returns a copy of this adapter without any plugins.
   */
  withoutPlugins(): GenericSQLAdapter {
    return new GenericSQLAdapter(this.#dialect, this.#executor.withoutPlugins(), this.#driver);
  }

  /**
   * Releases all resources and disconnects from the database.
   */
  async destroy(): Promise<void> {
    if (this.#driver !== null) {
      await this.#driver.destroy();
    }
  }
}
