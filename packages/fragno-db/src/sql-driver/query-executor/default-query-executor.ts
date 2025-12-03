/**
 * Adapted from Kysely's DefaultQueryExecutor
 * Modified from: https://github.com/kysely-org/kysely
 * License: MIT
 * Copyright (c) 2022 Sami Koskimäki
 *
 * Simplified to remove query compilation.
 */

import type { DatabaseConnection } from "../sql-driver";
import type { ConnectionProvider } from "../connection/connection-provider";
import type { GenericSQLPlugin } from "./plugin";
import { QueryExecutorBase } from "./query-executor-base";

export class DefaultQueryExecutor extends QueryExecutorBase {
  readonly #connectionProvider: ConnectionProvider;

  constructor(connectionProvider: ConnectionProvider, plugins: GenericSQLPlugin[] = []) {
    super(plugins);
    this.#connectionProvider = connectionProvider;
  }

  provideConnection<T>(consumer: (connection: DatabaseConnection) => Promise<T>): Promise<T> {
    return this.#connectionProvider.provideConnection(consumer);
  }

  withConnectionProvider(connectionProvider: ConnectionProvider): DefaultQueryExecutor {
    return new DefaultQueryExecutor(connectionProvider, [...this.plugins]);
  }

  withPlugin(plugin: GenericSQLPlugin): DefaultQueryExecutor {
    return new DefaultQueryExecutor(this.#connectionProvider, [...this.plugins, plugin]);
  }

  withoutPlugins(): DefaultQueryExecutor {
    return new DefaultQueryExecutor(this.#connectionProvider, []);
  }
}
