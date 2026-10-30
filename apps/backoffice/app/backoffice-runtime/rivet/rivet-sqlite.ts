import type {
  SqliteDatabase as ChordSqliteDatabase,
  SqliteExecutor as ChordSqliteExecutor,
  SqliteValue as ChordSqliteValue,
} from "@earendil-works/chord/sqlite";
import {
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryResult,
} from "kysely";
import type {
  DatabaseProvider,
  DatabaseProviderContext,
  RawAccess,
  SqliteBindings,
  SqliteDatabase,
} from "rivetkit/db";

/** The SQL operations of an actor's connection or of one of its open transactions. */
type RivetSqliteExecutor = Pick<SqliteDatabase, "exec" | "execute">;

/**
 * Hands each actor its native SQLite connection. rivetkit's `db()` wraps it in a client that drops
 * affected-row counts, which Fragno's optimistic concurrency checks read.
 */
export const nativeRivetSqlite = {
  createClient: async (context: DatabaseProviderContext) => {
    if (!context.nativeDatabaseProvider) {
      throw new Error("The Rivet runtime did not provide native SQLite.");
    }
    return await context.nativeDatabaseProvider.open(context.actorId);
  },
  onMigrate: () => {},
  // rivetkit types `c.db` as its own client; actors read it as the native connection.
} as unknown as DatabaseProvider<RawAccess>;

/** Reads the native connection that `nativeRivetSqlite` provides. */
export function rivetSqlite(db: RawAccess): SqliteDatabase {
  return db as unknown as SqliteDatabase;
}

/** Rows as objects. Native SQLite returns BLOBs as arrays of bytes. */
export function rivetSqliteRows<TRow>(result: { columns: string[]; rows: unknown[][] }): TRow[] {
  return result.rows.map((row) => {
    const object: Record<string, unknown> = {};
    for (let index = 0; index < result.columns.length; index += 1) {
      const value = row[index];
      object[result.columns[index]] = Array.isArray(value) ? Uint8Array.from(value) : value;
    }
    return object as TRow;
  });
}

/** Kysely over an actor's SQLite, the database Fragno, auth and Pi share as on Cloudflare. */
export class RivetSqliteDialect implements Dialect {
  readonly #database: SqliteDatabase;

  constructor(database: SqliteDatabase) {
    this.#database = database;
  }

  createAdapter() {
    return new SqliteAdapter();
  }

  createDriver(): Driver {
    return new RivetSqliteDriver(this.#database);
  }

  createQueryCompiler() {
    return new SqliteQueryCompiler();
  }

  createIntrospector(db: Kysely<unknown>) {
    return new SqliteIntrospector(db);
  }
}

class RivetSqliteDriver implements Driver {
  readonly #database: SqliteDatabase;

  constructor(database: SqliteDatabase) {
    this.#database = database;
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return new RivetSqliteConnection(this.#database);
  }

  async beginTransaction(connection: RivetSqliteConnection): Promise<void> {
    await connection.begin();
  }

  async commitTransaction(connection: RivetSqliteConnection): Promise<void> {
    await connection.end("commit");
  }

  async rollbackTransaction(connection: RivetSqliteConnection): Promise<void> {
    await connection.end("rollback");
  }

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {}
}

class RivetSqliteConnection implements DatabaseConnection {
  readonly #database: SqliteDatabase;
  #transaction: Awaited<ReturnType<SqliteDatabase["beginTransaction"]>> | null = null;

  constructor(database: SqliteDatabase) {
    this.#database = database;
  }

  async begin(): Promise<void> {
    // Until it ends, the actor's other statements wait.
    this.#transaction = await this.#database.beginTransaction(undefined, "kysely");
  }

  async end(outcome: "commit" | "rollback"): Promise<void> {
    const transaction = this.#transaction;
    this.#transaction = null;
    if (!transaction) {
      throw new Error("No Rivet SQLite transaction is open.");
    }
    await (outcome === "commit" ? transaction.commit() : transaction.rollback());
  }

  async executeQuery<TRow>(query: CompiledQuery): Promise<QueryResult<TRow>> {
    const executor: RivetSqliteExecutor = this.#transaction ?? this.#database;
    const result = await executor.execute(query.sql, query.parameters as SqliteBindings);
    return {
      rows: rivetSqliteRows<TRow>(result),
      numAffectedRows: BigInt(result.changes),
    };
  }

  async *streamQuery<TRow>(
    query: CompiledQuery,
    chunkSize: number,
  ): AsyncIterableIterator<QueryResult<TRow>> {
    const { rows } = await this.executeQuery<TRow>(query);
    for (let start = 0; start < rows.length; start += chunkSize) {
      yield { rows: rows.slice(start, start + chunkSize) };
    }
  }
}

/** The chord database Pi's session storage opens on an actor's SQLite. */
export function rivetChordSqlite(database: SqliteDatabase): ChordSqliteDatabase {
  return {
    ...chordExecutor(database),
    async transaction(callback) {
      const transaction = await database.beginTransaction(undefined, "pi");
      try {
        const result = await callback(chordExecutor(transaction));
        await transaction.commit();
        return result;
      } catch (error) {
        await transaction.rollback();
        throw error;
      }
    },
    // The actor owns its connection.
    async close() {},
  };
}

function chordExecutor(executor: RivetSqliteExecutor): ChordSqliteExecutor {
  const all = async <T>(sql: string, params: ChordSqliteValue[]) =>
    rivetSqliteRows<T>(await executor.execute(sql, params as SqliteBindings));
  return {
    async exec(sql) {
      await executor.exec(sql);
    },
    async run(sql, ...params) {
      await executor.execute(sql, params as SqliteBindings);
    },
    async get<T extends object>(sql: string, ...params: ChordSqliteValue[]) {
      return (await all<T>(sql, params))[0];
    },
    all: async <T extends object>(sql: string, ...params: ChordSqliteValue[]) =>
      await all<T>(sql, params),
  };
}

/** Runs a raw statement, as the migration import and object state do. */
export async function executeRivetSqlite(
  executor: RivetSqliteExecutor,
  sql: string,
  ...params: unknown[]
): Promise<Record<string, unknown>[]> {
  return rivetSqliteRows(await executor.execute(sql, params as SqliteBindings));
}
