/**
 * Adapted from Kysely's QueryExecutorBase
 * Modified from: https://github.com/kysely-org/kysely
 * License: MIT
 * Copyright (c) 2022 Sami Koskimäki
 *
 * Simplified to remove query compilation, streaming, and batching.
 */

import type { DatabaseConnection, CompiledQuery, QueryResult } from "../sql-driver";
import type { ConnectionProvider } from "../connection/connection-provider";
import type { GenericSQLPlugin } from "./plugin";
import type { QueryExecutor } from "./query-executor";

const NO_PLUGINS: ReadonlyArray<GenericSQLPlugin> = Object.freeze([]);

export abstract class QueryExecutorBase implements QueryExecutor {
  readonly #plugins: ReadonlyArray<GenericSQLPlugin>;

  constructor(plugins: ReadonlyArray<GenericSQLPlugin> = NO_PLUGINS) {
    this.#plugins = plugins;
  }

  get plugins(): ReadonlyArray<GenericSQLPlugin> {
    return this.#plugins;
  }

  abstract provideConnection<T>(
    consumer: (connection: DatabaseConnection) => Promise<T>,
  ): Promise<T>;

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    return await this.provideConnection(async (connection) => {
      const result = await connection.executeQuery(compiledQuery);
      return await this.#transformResult(result);
    });
  }

  abstract withConnectionProvider(connectionProvider: ConnectionProvider): QueryExecutorBase;

  abstract withPlugin(plugin: GenericSQLPlugin): QueryExecutorBase;

  abstract withoutPlugins(): QueryExecutorBase;

  // oxlint-disable-next-line no-explicit-any
  async #transformResult<T>(result: QueryResult<any>): Promise<QueryResult<T>> {
    for (const plugin of this.#plugins) {
      result = await plugin.transformResult({ result });
    }

    return result;
  }
}
