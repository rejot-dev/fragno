import * as SQLite from "@journeyapps/wa-sqlite";

import type { LofiSqliteDatabase } from "./adapter";
import type { SqliteValue } from "./values";

/**
 * A synchronous SQLite connection, which view engines read. IVM operators pull rows in the middle
 * of a push, so they cannot wait for their database.
 */
export type LofiSqliteSyncConnection = {
  /**
   * Prepares one statement. SQL that holds no statement, or more SQL after the statement than
   * whitespace and comments, throws, so a query cannot run a second statement unseen.
   */
  prepare(sql: string): LofiSqliteSyncStatement;
  /**
   * Runs `run`, during which `guard` decides what the statements prepared may do and limits the
   * work each statement does as it steps. Synchronous, so no other statement on the connection
   * runs meanwhile.
   */
  guarded<T>(guard: LofiSqliteGuard, run: () => T): T;
};

/** One access a statement makes, as SQLite's authorizer reports it while preparing the statement. */
export type LofiSqliteAccess = {
  /** SQLite's action code, such as `SQLITE_READ` (20) or `SQLITE_FUNCTION` (31). */
  action: number;
  /**
   * The action's details, such as the table and column a read reads, or, second, the function a
   * call calls.
   */
  details: readonly [string | null, string | null];
  /** The database the access touches, such as `"main"` or `"temp"`. */
  database: string | null;
  /** The innermost view or trigger the access is made through, or null for the statement's own. */
  source: string | null;
};

export type LofiSqliteGuard = {
  /** Whether a statement may make `access`; preparing one that makes a refused access throws. */
  authorize(access: LofiSqliteAccess): boolean;
  /**
   * How many of SQLite's virtual machine operations one run of a statement may take, counted in
   * thousands; a run that takes more throws.
   */
  maxOperations: number;
  /** The longest string or blob, in bytes, a statement may produce. */
  maxLength: number;
};

export type LofiSqliteSyncStatement = {
  /** The result columns, in the order of a row's values. */
  readonly columnNames: readonly string[];
  /** Whether the statement leaves the database unchanged. */
  readonly isReadOnly: boolean;
  /**
   * The tables and views the statement reads, by name, including the tables it reads through
   * views. Changes to other tables cannot change its rows.
   */
  readonly tables: ReadonlySet<string>;
  /** How many parameters the statement takes. */
  readonly parameterCount: number;
  /**
   * Runs the statement and yields each row's values, with integers outside the safe range as
   * bigints. Returning the iterator early ends the run.
   */
  rows(params: readonly unknown[]): IterableIterator<SqliteValue[]>;
};

/** One wa-sqlite connection, read synchronously by view engines and asynchronously by the replica. */
export type LofiSqliteSyncDatabase = LofiSqliteDatabase & {
  /**
   * Statements that run synchronously. A VFS like OPFSCoopSyncVFS can only lock the database
   * asynchronously, so they work only while the connection already holds a lock, such as inside a
   * transaction that has read.
   */
  readonly connection: LofiSqliteSyncConnection;
  close(): Promise<void>;
};

/** What statements call on the Emscripten module of wa-sqlite's synchronous build. */
type WaSqliteModule = {
  // wa-sqlite's hooks are installed per module, so a connection installs them only while it runs
  // synchronously, and removes them before any other connection of the module can run.
  set_authorizer(db: number, authorizer: null, app: number): number;
  progress_handler(db: number, operations: number, handler: null, app: number): void;
  cwrap(
    name: string,
    returnType: "number" | "string" | null,
    argumentTypes: ("number" | "string")[],
  ): (...args: unknown[]) => unknown;
  getTempRet0(): number;
  getValue(pointer: number, type: "*"): number;
  _getSqliteFree(): number;
  _sqlite3_malloc(size: number): number;
  _sqlite3_free(pointer: number): void;
  HEAPU8: Uint8Array;
};

const SQLITE_PREPARE_PERSISTENT = 0x01;

/**
 * Wraps a connection that `sqlite3` opened on `module`, which must be wa-sqlite's synchronous
 * build (`dist/wa-sqlite.mjs`).
 */
export function wrapWaSqliteDatabase(options: {
  module: unknown;
  sqlite3: SQLiteAPI;
  db: number;
  close: () => Promise<void>;
}): LofiSqliteSyncDatabase {
  const { sqlite3, db } = options;
  const statements = createStatements(options.module as WaSqliteModule, sqlite3, db);
  return {
    async execute(sql, params = []) {
      const rows: Record<string, unknown>[] = [];
      for await (const statement of sqlite3.statements(db, sql)) {
        if (params.length > 0) {
          sqlite3.bind_collection(statement, params as SQLiteCompatibleType[]);
        }
        const columns = sqlite3.column_names(statement);
        while ((await sqlite3.step(statement)) === SQLite.SQLITE_ROW) {
          const values = sqlite3.row(statement);
          rows.push(
            Object.fromEntries(
              // Blob values view wasm memory, which the next statement overwrites.
              columns.map((name, index) => {
                const value = values[index];
                return [name, value instanceof Uint8Array ? value.slice() : value];
              }),
            ),
          );
        }
      }
      return rows;
    },
    connection: statements.connection,
    async close() {
      // sqlite3_close refuses a connection with statements left.
      statements.finalizeAll();
      await options.close();
    },
  };
}

const SQLITE_READ = 20;
const SQLITE_DENY = 1;
const SQLITE_LIMIT_LENGTH = 0;
// How many operations SQLite runs between calls of the progress handler.
const OPERATIONS_PER_PROGRESS = 1000;

function createStatements(module: WaSqliteModule, sqlite3: SQLiteAPI, db: number) {
  const n = "number" as const;
  const c = {
    prepare: module.cwrap("sqlite3_prepare_v3", n, [n, n, n, n, n, n]),
    step: module.cwrap("sqlite3_step", n, [n]),
    reset: module.cwrap("sqlite3_reset", n, [n]),
    clearBindings: module.cwrap("sqlite3_clear_bindings", n, [n]),
    finalize: module.cwrap("sqlite3_finalize", n, [n]),
    bindInt64: module.cwrap("sqlite3_bind_int64", n, [n, n, n, n]),
    bindDouble: module.cwrap("sqlite3_bind_double", n, [n, n, n]),
    bindText: module.cwrap("sqlite3_bind_text", n, [n, n, n, n, n]),
    bindBlob: module.cwrap("sqlite3_bind_blob", n, [n, n, n, n, n]),
    bindNull: module.cwrap("sqlite3_bind_null", n, [n, n]),
    columnCount: module.cwrap("sqlite3_column_count", n, [n]),
    columnName: module.cwrap("sqlite3_column_name", "string", [n, n]),
    columnType: module.cwrap("sqlite3_column_type", n, [n, n]),
    columnInt64: module.cwrap("sqlite3_column_int64", n, [n, n]),
    columnDouble: module.cwrap("sqlite3_column_double", n, [n, n]),
    columnText: module.cwrap("sqlite3_column_text", "string", [n, n]),
    columnBlob: module.cwrap("sqlite3_column_blob", n, [n, n]),
    columnBytes: module.cwrap("sqlite3_column_bytes", n, [n, n]),
    stmtReadonly: module.cwrap("sqlite3_stmt_readonly", n, [n]),
    parameterCount: module.cwrap("sqlite3_bind_parameter_count", n, [n]),
    limit: module.cwrap("sqlite3_limit", n, [n, n, n]),
    errmsg: module.cwrap("sqlite3_errmsg", "string", [n]),
  };
  const sqliteFree = module._getSqliteFree();
  const encoder = new TextEncoder();
  const live = new Set<number>();
  const finalizer = new FinalizationRegistry<number>((statement) => {
    if (live.delete(statement)) {
      c.finalize(statement);
    }
  });

  const check = (result: unknown, allowed: number[] = [SQLite.SQLITE_OK]) => {
    if (!allowed.includes(result as number)) {
      throw new Error(`SQLite error ${String(result)}: ${String(c.errmsg(db))}`);
    }
    return result as number;
  };

  /** Copies `bytes` into SQLite-owned memory, which the binding frees. */
  const copyIn = (bytes: Uint8Array) => {
    const pointer = module._sqlite3_malloc(Math.max(bytes.byteLength, 1));
    module.HEAPU8.set(bytes, pointer);
    return pointer;
  };

  // The build passes a 64-bit integer as its low and high 32 bits.
  const bindInteger = (statement: number, index: number, value: bigint) =>
    c.bindInt64(statement, index, Number(value & 0xffffffffn), Number(value >> 32n));

  const bind = (statement: number, index: number, value: unknown) => {
    if (value === null || value === undefined) {
      return c.bindNull(statement, index);
    }
    if (typeof value === "boolean") {
      return bindInteger(statement, index, value ? 1n : 0n);
    }
    if (typeof value === "bigint") {
      return bindInteger(statement, index, value);
    }
    if (typeof value === "number") {
      return Number.isSafeInteger(value)
        ? bindInteger(statement, index, BigInt(value))
        : c.bindDouble(statement, index, value);
    }
    if (typeof value === "string") {
      const bytes = encoder.encode(value);
      return c.bindText(statement, index, copyIn(bytes), bytes.byteLength, sqliteFree);
    }
    if (value instanceof Uint8Array) {
      return c.bindBlob(statement, index, copyIn(value), value.byteLength, sqliteFree);
    }
    throw new TypeError(`Cannot bind ${typeof value} to SQLite`);
  };

  const readValue = (statement: number, column: number): SqliteValue => {
    switch (c.columnType(statement, column)) {
      case SQLite.SQLITE_NULL:
        return null;
      case SQLite.SQLITE_INTEGER: {
        const low = c.columnInt64(statement, column) as number;
        const high = module.getTempRet0();
        const value = (BigInt(high) << 32n) | (BigInt(low) & 0xffffffffn);
        return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(value)
          : value;
      }
      case SQLite.SQLITE_FLOAT:
        return c.columnDouble(statement, column) as number;
      case SQLite.SQLITE_TEXT:
        return c.columnText(statement, column) as string;
      default: {
        const pointer = c.columnBlob(statement, column) as number;
        // Copied, since the bytes live in wasm memory until the next step.
        return module.HEAPU8.slice(pointer, pointer + (c.columnBytes(statement, column) as number));
      }
    }
  };

  // The guard of the statements run in `guarded`, which spends `operations` as they step.
  let active: {
    guard: LofiSqliteGuard;
    operations: number;
    refused: LofiSqliteAccess | null;
  } | null = null;

  /**
   * Prepares the first statement of `sql`, and returns it with the byte offset where it ends; zero
   * when `sql` holds only whitespace and comments. `tables` collects the tables it reads.
   */
  const prepareOne = (bytes: Uint8Array, tables: Set<string>) => {
    const text = copyIn(bytes);
    const out = module._sqlite3_malloc(8);
    // wa-sqlite passes an absent string as "", which no name SQLite reports is.
    const name = (value: string | null) => (value === "" ? null : value);
    sqlite3.set_authorizer(
      db,
      (_app, action, first, second, database, source) => {
        const access: LofiSqliteAccess = {
          action,
          details: [name(first), name(second)],
          database: name(database),
          source: name(source),
        };
        if (active && !active.guard.authorize(access)) {
          active.refused ??= access;
          return SQLITE_DENY;
        }
        if (action === SQLITE_READ && access.details[0] !== null) {
          tables.add(access.details[0]);
        }
        return SQLite.SQLITE_OK;
      },
      null,
    );
    try {
      check(c.prepare(db, text, bytes.byteLength, SQLITE_PREPARE_PERSISTENT, out, out + 4));
      return {
        statement: module.getValue(out, "*"),
        end: module.getValue(out + 4, "*") - text,
      };
    } finally {
      module.set_authorizer(db, null, 0);
      module._sqlite3_free(out);
      module._sqlite3_free(text);
    }
  };

  const prepare = (sql: string): LofiSqliteSyncStatement => {
    const bytes = encoder.encode(sql);
    const tables = new Set<string>();
    const { statement, end } = prepareOne(bytes, tables);
    if (statement === 0) {
      throw new Error(`SQL holds no statement: ${sql}`);
    }
    live.add(statement);
    try {
      // What follows the statement must prepare to nothing, as whitespace and comments do.
      for (let offset = end; offset < bytes.byteLength; ) {
        const next = prepareOne(bytes.subarray(offset), new Set());
        if (next.statement !== 0) {
          c.finalize(next.statement);
          throw new Error(`SQL holds more than one statement: ${sql}`);
        }
        if (next.end === 0) {
          break;
        }
        offset += next.end;
      }
    } catch (error) {
      live.delete(statement);
      c.finalize(statement);
      throw error;
    }
    const columnNames = Array.from({ length: c.columnCount(statement) as number }, (_, index) =>
      String(c.columnName(statement, index)),
    );
    const prepared: LofiSqliteSyncStatement = {
      columnNames,
      isReadOnly: c.stmtReadonly(statement) !== 0,
      tables,
      parameterCount: c.parameterCount(statement) as number,
      *rows(params) {
        c.reset(statement);
        c.clearBindings(statement);
        for (const [index, value] of params.entries()) {
          check(bind(statement, index + 1, value));
        }
        if (active) {
          active.operations = 0;
        }
        try {
          for (;;) {
            const result = c.step(statement) as number;
            if (result === SQLite.SQLITE_INTERRUPT && active) {
              throw new Error(
                `The statement took more than ${active.guard.maxOperations * OPERATIONS_PER_PROGRESS} operations.`,
              );
            }
            check(result, [SQLite.SQLITE_ROW, SQLite.SQLITE_DONE]);
            if (result === SQLite.SQLITE_DONE) {
              return;
            }
            yield columnNames.map((_, column) => readValue(statement, column));
          }
        } finally {
          c.reset(statement);
        }
      },
    };
    finalizer.register(prepared, statement);
    return prepared;
  };

  const guarded = <T>(guard: LofiSqliteGuard, run: () => T): T => {
    if (active) {
      throw new Error("Guarded runs do not nest.");
    }
    const state = { guard, operations: 0, refused: null as LofiSqliteAccess | null };
    active = state;
    const length = c.limit(db, SQLITE_LIMIT_LENGTH, guard.maxLength) as number;
    sqlite3.progress_handler(
      db,
      OPERATIONS_PER_PROGRESS,
      () => {
        state.operations += 1;
        return state.operations > guard.maxOperations ? 1 : 0;
      },
      null,
    );
    try {
      return run();
    } catch (error) {
      // SQLite reports a refused access as "not authorized", without naming it.
      if (state.refused) {
        throw new LofiSqliteAccessError(state.refused, { cause: error });
      }
      throw error;
    } finally {
      module.progress_handler(db, 0, null, 0);
      c.limit(db, SQLITE_LIMIT_LENGTH, length);
      active = null;
    }
  };

  return {
    connection: { prepare, guarded },
    finalizeAll() {
      for (const statement of live) {
        c.finalize(statement);
      }
      live.clear();
    },
  };
}

/** A statement prepared in a guarded run made an access its guard refused. */
export class LofiSqliteAccessError extends Error {
  readonly access: LofiSqliteAccess;

  constructor(access: LofiSqliteAccess, options: { cause: unknown }) {
    super(`Not authorized: ${describeAccess(access)}.`, options);
    this.name = "LofiSqliteAccessError";
    this.access = access;
  }
}

function describeAccess({ action, details, source }: LofiSqliteAccess): string {
  const [first, second] = details;
  const parts = [`action ${action}`, first, second, source && `through ${source}`];
  return parts.filter((part) => part !== null && part !== "").join(" ");
}
