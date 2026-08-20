import {
  CompiledQuery,
  Kysely,
  SqliteAdapter,
  SqliteQueryCompiler,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type Driver,
  type QueryCompiler,
  type QueryResult,
} from "kysely";

interface DurableObjectId {
  toString(): string;
  equals(other: DurableObjectId): boolean;
  readonly name?: string;
}

interface DurableObjectTransaction {
  rollback(): void;
}

type SqlStorageValue = ArrayBuffer | string | number | null;

interface SqlStorage {
  exec<T extends Record<string, SqlStorageValue>>(
    query: string,
    // oxlint-disable-next-line no-explicit-any
    ...bindings: any[]
  ): SqlStorageCursor<T>;
  Cursor: typeof SqlStorageCursor;
  Statement: typeof SqlStorageStatement;
}

declare abstract class SqlStorageStatement {}
declare abstract class SqlStorageCursor<T extends Record<string, SqlStorageValue>> {
  next():
    | {
        done?: false;
        value: T;
      }
    | {
        done: true;
        value?: never;
      };
  toArray(): T[];
  one(): T;
  raw<U extends SqlStorageValue[]>(): IterableIterator<U>;
  columnNames: string[];
  get rowsRead(): number;
  get rowsWritten(): number;
  [Symbol.iterator](): IterableIterator<T>;
}

interface DurableObjectStorage {
  transaction<T>(closure: (txn: DurableObjectTransaction) => Promise<T>): Promise<T>;

  readonly sql: SqlStorage;
}

interface DurableObjectState {
  readonly id: DurableObjectId;
  readonly storage: DurableObjectStorage;
}

/**
 * Config for the Durable Objects dialect. Pass your Durable Object state to this object.
 */
export interface DODialectConfig {
  ctx: DurableObjectState;
}

/**
 * DO dialect that adds support for [Cloudflare Durable Objects][0] in [Kysely][1].
 * The constructor takes the Durable Object state context.
 *
 * ```typescript
 * new DurableObjectDialect({
 *   ctx: this.ctx,
 * })
 * ```
 *
 * [0]: https://developers.cloudflare.com/durable-objects/
 * [1]: https://github.com/koskimas/kysely
 */
export class DurableObjectDialect implements Dialect {
  readonly #config: DODialectConfig;

  constructor(config: DODialectConfig) {
    this.#config = config;
  }

  createAdapter() {
    return new SqliteAdapter();
  }

  createDriver(): Driver {
    return new DurableObjectDriver(this.#config);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createIntrospector(_db: Kysely<unknown>): DatabaseIntrospector {
    return new DurableObjectIntrospector(this.#config);
  }
}

type SqliteObjectMetadata = {
  name: string;
  sql: string | null;
  type: string;
};

type SqliteColumnMetadata = {
  tableName: string;
  cid: number;
  name: string;
  type: string;
  notnull: number;
  defaultValue: SqlStorageValue;
  primaryKeyPosition: number;
};

function findAutoIncrementColumn(
  createSql: string | null,
  columns: readonly SqliteColumnMetadata[],
): string | null {
  const declaredAutoIncrementColumn = createSql
    ?.split(/[(),]/u)
    .find((definition) => definition.toLowerCase().includes("autoincrement"))
    ?.trimStart()
    .split(/\s+/u)[0]
    ?.replace(/["`]/gu, "");
  if (declaredAutoIncrementColumn) {
    return declaredAutoIncrementColumn;
  }

  const primaryKeyColumns = columns.filter((column) => column.primaryKeyPosition > 0);
  return primaryKeyColumns.length === 1 && primaryKeyColumns[0]?.type.toLowerCase() === "integer"
    ? primaryKeyColumns[0].name
    : null;
}

class DurableObjectIntrospector implements DatabaseIntrospector {
  readonly #config: DODialectConfig;

  constructor(config: DODialectConfig) {
    this.#config = config;
  }

  async getSchemas() {
    return [];
  }

  async getTables(options: { withInternalKyselyTables?: boolean } = {}) {
    const tables = this.#config.ctx.storage.sql
      .exec<SqliteObjectMetadata>(
        `SELECT name, sql, type
         FROM sqlite_master
         WHERE type IN ('table', 'view')
           AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .toArray()
      .filter(
        ({ name }) =>
          options.withInternalKyselyTables ||
          (name !== "kysely_migration" && name !== "kysely_migration_lock"),
      );
    const columns = this.#config.ctx.storage.sql
      .exec<SqliteColumnMetadata>(
        `SELECT objects.name AS tableName,
                columns.cid,
                columns.name,
                columns.type,
                columns."notnull" AS "notnull",
                columns.dflt_value AS defaultValue,
                columns.pk AS primaryKeyPosition
         FROM sqlite_master AS objects,
              pragma_table_info(objects.name) AS columns
         WHERE objects.type IN ('table', 'view')
           AND objects.name NOT LIKE 'sqlite_%'
         ORDER BY objects.name, columns.cid`,
      )
      .toArray();
    const columnsByTable = new Map<string, SqliteColumnMetadata[]>();
    for (const column of columns) {
      const tableColumns = columnsByTable.get(column.tableName) ?? [];
      tableColumns.push(column);
      columnsByTable.set(column.tableName, tableColumns);
    }

    return tables.map(({ name, sql: createSql, type }) => {
      const tableColumns = columnsByTable.get(name) ?? [];
      const autoIncrementColumn = findAutoIncrementColumn(createSql, tableColumns);
      return {
        name,
        isView: type === "view",
        columns: tableColumns.map((column) => ({
          name: column.name,
          dataType: column.type,
          isNullable: !column.notnull,
          isAutoIncrementing: column.name === autoIncrementColumn,
          hasDefaultValue: column.defaultValue !== null,
          comment: undefined,
        })),
      };
    });
  }

  async getMetadata(options?: { withInternalKyselyTables?: boolean }) {
    return { tables: await this.getTables(options) };
  }
}

class DurableObjectDriver implements Driver {
  readonly #config: DODialectConfig;

  constructor(config: DODialectConfig) {
    this.#config = config;
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return new DOConnection(this.#config);
  }

  async beginTransaction(conn: DOConnection): Promise<void> {
    await conn.beginTransaction();
  }

  async commitTransaction(conn: DOConnection): Promise<void> {
    await conn.commitTransaction();
  }

  async rollbackTransaction(conn: DOConnection): Promise<void> {
    await conn.rollbackTransaction();
  }

  async releaseConnection(_conn: DOConnection): Promise<void> {
    // No-op
  }

  async destroy(): Promise<void> {
    // No-op
  }
}

class DOConnection implements DatabaseConnection {
  readonly #config: DODialectConfig;
  #transactionPromise: Promise<void> | null = null;
  #transactionControl: {
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;
  #txn: DurableObjectTransaction | null = null;

  constructor(config: DODialectConfig) {
    this.#config = config;
  }

  async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
    let cursor: SqlStorageCursor<Record<string, SqlStorageValue>>;
    try {
      cursor = this.#config.ctx.storage.sql.exec(compiledQuery.sql, ...compiledQuery.parameters);
    } catch (error) {
      throw new Error(`Durable Object SQLite rejected query: ${compiledQuery.sql}`, {
        cause: error,
      });
    }

    const rows = cursor.toArray() as O[];
    const numAffectedRows = cursor.rowsWritten > 0 ? BigInt(cursor.rowsWritten) : undefined;

    return {
      insertId: undefined, // Durable Objects doesn't provide last_row_id like D1
      rows: rows || [],
      numAffectedRows,
    };
  }

  async beginTransaction() {
    if (this.#transactionPromise) {
      throw new Error("Transaction already in progress");
    }

    // Use a promise to wait for the transaction closure to actually start
    let transactionReady: (() => void) | null = null;
    const readyPromise = new Promise<void>((resolve) => {
      transactionReady = resolve;
    });

    // Start the transaction - all queries executed will be inside this closure
    this.#transactionPromise = this.#config.ctx.storage
      .transaction(async (txn) => {
        this.#txn = txn;

        // Wait for commit or rollback to be called
        await new Promise<void>((resolve, reject) => {
          this.#transactionControl = { resolve, reject };
          // Signal that transaction is ready
          if (transactionReady) {
            transactionReady();
          }
        });
      })
      .catch((error: unknown) => {
        // Don't clear state here - let commit/rollback handle it
        throw error;
      });

    // Wait for the transaction closure to set up before returning
    await readyPromise;
  }

  async commitTransaction() {
    if (!this.#transactionPromise || !this.#transactionControl) {
      throw new Error("No transaction to commit");
    }

    try {
      // Signal commit and wait for transaction to complete
      this.#transactionControl.resolve();
      await this.#transactionPromise;
    } finally {
      this.#transactionPromise = null;
      this.#transactionControl = null;
      this.#txn = null;
    }
  }

  async rollbackTransaction() {
    if (!this.#transactionPromise || !this.#transactionControl) {
      throw new Error("No transaction to rollback");
    }

    try {
      // Signal rollback
      if (this.#txn) {
        this.#txn.rollback();
      }
      this.#transactionControl.reject(new Error("Transaction rolled back"));

      // Wait for transaction to complete (will reject, but we catch it)
      await this.#transactionPromise.catch(() => {
        /* Expected to reject on rollback */
      });
    } finally {
      this.#transactionPromise = null;
      this.#transactionControl = null;
      this.#txn = null;
    }
  }

  // oxlint-disable-next-line require-yield
  async *streamQuery<O>(
    _compiledQuery: CompiledQuery,
    _chunkSize: number,
  ): AsyncIterableIterator<QueryResult<O>> {
    throw new Error("DO Driver does not support streaming");
  }
}
