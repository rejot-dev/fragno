/**
 * These interfaces are adapted from Kysely.
 * Modified from: https://github.com/kysely-org/kysely
 * License: MIT
 * Date obtained: December 3 2025
 * Copyright (c) 2022 Sami Koskimäki
 */

import type { DialectAdapter } from "./dialect-adapter/dialect-adapter";

export interface CompiledQuery {
  readonly sql: string;
  readonly parameters: ReadonlyArray<unknown>;
}

export interface DatabaseConnection {
  executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>>;
}

export interface QueryResult<O> {
  readonly numAffectedRows?: bigint;
  readonly numChangedRows?: bigint;
  readonly insertId?: bigint;

  readonly rows: O[];
}

export interface TransactionSettings {
  //
}

export interface Driver {
  init(): Promise<void>;

  acquireConnection(): Promise<DatabaseConnection>;
  releaseConnection(connection: DatabaseConnection): Promise<void>;

  beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void>;
  commitTransaction(connection: DatabaseConnection): Promise<void>;
  rollbackTransaction(connection: DatabaseConnection): Promise<void>;

  destroy(): Promise<void>;
}

export interface QueryCompiler {
  compileQuery(node: unknown, queryId: unknown): CompiledQuery;
}

export interface Dialect {
  createDriver(): Driver;
  createAdapter(): DialectAdapter;
  createQueryCompiler(): QueryCompiler;
}
