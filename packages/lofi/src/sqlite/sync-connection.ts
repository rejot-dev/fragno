import * as SQLite from "@journeyapps/wa-sqlite";

import type { LofiSqliteDatabase } from "./adapter";
import type { SqliteValue } from "./values";

/**
 * A synchronous SQLite connection, which view engines read. IVM operators pull rows in the middle
 * of a push, so they cannot wait for their database.
 */
export type LofiSqliteSyncConnection = {
  prepare(sql: string): LofiSqliteSyncStatement;
};

export type LofiSqliteSyncStatement = {
  /** The result columns, in the order of a row's values. */
  readonly columnNames: readonly string[];
  /** Whether the statement leaves the database unchanged. */
  readonly isReadOnly: boolean;
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
  const statements = createStatements(options.module as WaSqliteModule, db);
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

function createStatements(module: WaSqliteModule, db: number) {
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

  const prepare = (sql: string): LofiSqliteSyncStatement => {
    const bytes = encoder.encode(sql);
    const text = copyIn(bytes);
    const out = module._sqlite3_malloc(4);
    let statement: number;
    try {
      check(c.prepare(db, text, bytes.byteLength, SQLITE_PREPARE_PERSISTENT, out, 0));
      statement = module.getValue(out, "*");
    } finally {
      module._sqlite3_free(out);
      module._sqlite3_free(text);
    }
    live.add(statement);
    const columnNames = Array.from({ length: c.columnCount(statement) as number }, (_, index) =>
      String(c.columnName(statement, index)),
    );
    const prepared: LofiSqliteSyncStatement = {
      columnNames,
      isReadOnly: c.stmtReadonly(statement) !== 0,
      *rows(params) {
        c.reset(statement);
        c.clearBindings(statement);
        for (const [index, value] of params.entries()) {
          check(bind(statement, index + 1, value));
        }
        try {
          for (;;) {
            const result = check(c.step(statement), [SQLite.SQLITE_ROW, SQLite.SQLITE_DONE]);
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

  return {
    connection: { prepare },
    finalizeAll() {
      for (const statement of live) {
        c.finalize(statement);
      }
      live.clear();
    },
  };
}
