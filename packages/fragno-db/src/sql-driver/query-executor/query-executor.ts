/**
 * Adapted from Kysely's QueryExecutor
 * Modified from: https://github.com/kysely-org/kysely
 * License: MIT
 * Copyright (c) 2022 Sami Koskimäki
 *
 * Simplified to remove query compilation, streaming, and batching.
 */

import type { CompiledQuery, QueryResult } from "../sql-driver";
import type { ConnectionProvider } from "../connection/connection-provider";
import type { GenericSQLPlugin } from "./plugin";

/**
 * This interface abstracts away the details of how to execute a query.
 */
export interface QueryExecutor extends ConnectionProvider {
  /**
   * Returns all installed plugins.
   */
  get plugins(): ReadonlyArray<GenericSQLPlugin>;

  /**
   * Executes a compiled query and runs the result through all plugins'
   * `transformResult` method.
   */
  executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>>;

  /**
   * Returns a copy of this executor with a new connection provider.
   */
  withConnectionProvider(connectionProvider: ConnectionProvider): QueryExecutor;

  /**
   * Returns a copy of this executor with a plugin added as the
   * last plugin.
   */
  withPlugin(plugin: GenericSQLPlugin): QueryExecutor;

  /**
   * Returns a copy of this executor without any plugins.
   */
  withoutPlugins(): QueryExecutor;
}
