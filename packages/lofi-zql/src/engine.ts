import { lofiSqliteTableName, registeredSchemaName } from "@fragno-dev/lofi/sqlite";
import type { LofiSqliteSyncConnection } from "@fragno-dev/lofi/sqlite/worker";

import type { LofiSchemaRegistration } from "@fragno-dev/lofi";

import { LogContext } from "@rocicorp/logger";

import { lofiZqlSchema } from "./schema";
import type { LogConfig } from "./vendor/otel/src/log-options.ts";
import type { Row } from "./vendor/zero-protocol/src/data.ts";
import type { SchemaValue } from "./vendor/zero-types/src/schema-value.ts";
import { buildPipeline, type BuilderDelegate } from "./vendor/zql/src/builder/builder.ts";
import { ArrayView } from "./vendor/zql/src/ivm/array-view.ts";
import { MemoryStorage } from "./vendor/zql/src/ivm/memory-storage.ts";
import {
  makeSourceChangeAdd,
  makeSourceChangeEdit,
  makeSourceChangeRemove,
  type SourceChange,
} from "./vendor/zql/src/ivm/source.ts";
import { consume } from "./vendor/zql/src/ivm/stream.ts";
import {
  fromSQLiteRawRow,
  rawColumn,
  TableSource,
  type RawColumn,
  type SQLiteValue,
} from "./vendor/zqlite/src/table-source.ts";
import type { LofiZqlViewQuery } from "./view-query";
import { Database, type Statement } from "./zqlite-database.ts";

/** One replica table as IVM reads it. */
type ZqlTable = {
  sqlName: string;
  columns: Record<string, SchemaValue>;
  rawColumns: RawColumn[];
  primaryKey: [string];
  readByInternalId: Statement;
  readById: Statement;
};

/** Holds the earlier values of each row a write touches, until IVM catches up with the write. */
const CHANGES_TABLE = `temp."lofi_zql_changes"`;

const LOG_CONFIG: LogConfig = {
  format: "text",
  level: "warn",
  ivmSampling: 0,
  slowHydrateThreshold: 0,
  slowAdvanceThreshold: 0,
  queryStatsIntervalSeconds: 0,
  slowRowThreshold: 0,
  planWarningRowThreshold: 0,
  planWarningCostThreshold: 0,
};

/**
 * Maintains ZQL views of a SQLite replica incrementally. The constructor and every method read the
 * database synchronously, so callers hold a lock on it, such as a read transaction.
 *
 * SQLite triggers record the earlier values of the rows this connection writes. `refresh` rewinds
 * each source to those values and pushes the rows' changes one at a time, which is what IVM
 * requires: every push must see the database as it was before the change. The triggers are
 * temporary, so they see only this connection's writes: no other connection may write the database.
 */
export class LofiZqlEngine {
  readonly #database: Database;
  readonly #lc = new LogContext("warn");
  /** By registered schema name, then Fragno table name. */
  readonly #tables: Map<string, Map<string, ZqlTable>>;
  readonly #tablesBySqlName: Map<string, ZqlTable>;
  readonly #sources = new Map<string, TableSource>();
  readonly #views = new Map<string, ArrayView<never>>();
  #recording = false;

  constructor(
    connection: LofiSqliteSyncConnection,
    registrations: readonly LofiSchemaRegistration[],
  ) {
    this.#database = new Database(connection);
    this.#tables = new Map(
      registrations.map((registration) => [
        registeredSchemaName(registration),
        new Map(
          Object.values(lofiZqlSchema(registration.schema).tables).map((table) => {
            const columns = table.columns as Record<string, SchemaValue>;
            const sqlName = lofiSqliteTableName(registration, table.name);
            const select = (column: string) =>
              this.#database
                .prepare(
                  `SELECT ${selectList(columns)} FROM ${quoteSqliteIdentifier(sqlName)} WHERE ${quoteSqliteIdentifier(column)} = ?`,
                )
                .raw(true);
            const fragnoTable = registration.schema.tables[table.name];
            return [
              table.name,
              {
                sqlName,
                columns,
                rawColumns: Object.keys(columns).map((name) => rawColumn(columns, name, sqlName)),
                primaryKey: [table.primaryKey[0]],
                readByInternalId: select(fragnoTable.getInternalIdColumn().name),
                readById: select(fragnoTable.getIdColumn().name),
              },
            ];
          }),
        ),
      ]),
    );
    this.#tablesBySqlName = new Map(
      [...this.#tables.values()].flatMap((tables) =>
        [...tables.values()].map((table) => [table.sqlName, table]),
      ),
    );
  }

  /** Builds a view of a query on the tables of a registered schema, and reports its data. */
  materialize(id: string, query: LofiZqlViewQuery, listener: (data: unknown) => void): void {
    this.refresh();
    this.destroy(id);
    this.#views.set(id, this.#build(id, query, listener));
  }

  destroy(id: string): void {
    this.#views.get(id)?.destroy();
    this.#views.delete(id);
  }

  /** Brings every view up to date with the database and reports the data of views that changed. */
  refresh(): void {
    if (!this.#recording) {
      this.#recordChanges();
      this.#recording = true;
      return;
    }
    this.#pushRecordedChanges();
  }

  #build(id: string, query: LofiZqlViewQuery, listener: (data: unknown) => void): ArrayView<never> {
    const tables = this.#tables.get(query.schemaName);
    if (!tables) {
      throw new Error(`Schema "${query.schemaName}" is not registered with the replica.`);
    }
    const delegate: BuilderDelegate = {
      // The replica holds whole tables, so a missing row is known to be missing.
      enableNotExists: true,
      getSource: (tableName) => {
        const table = tables.get(tableName);
        return table && this.#source(table);
      },
      createStorage: () => new MemoryStorage(),
      decorateInput: (input) => input,
      addEdge: () => {},
      decorateFilterInput: (input) => input,
      decorateSourceInput: (input) => input,
    };
    const input = buildPipeline(query.ast, delegate, id);
    const view = new ArrayView<never>(input, query.format, true, () => {});
    view.onDestroy = () => {
      input.destroy();
    };
    view.addListener((data) => {
      listener(data);
    });
    return view;
  }

  #source(table: ZqlTable): TableSource {
    let source = this.#sources.get(table.sqlName);
    if (!source) {
      source = new TableSource(
        this.#lc,
        LOG_CONFIG,
        this.#database,
        table.sqlName,
        table.columns,
        table.primaryKey,
        () => false,
        // Pushes go to an in-memory overlay; the replica has written them already.
        { deferWrites: true },
      );
      this.#sources.set(table.sqlName, source);
    }
    return source;
  }

  #recordChanges(): void {
    this.#run(
      `CREATE TEMP TABLE IF NOT EXISTS ${CHANGES_TABLE} ("table" TEXT NOT NULL, "row" INTEGER NOT NULL, "before" TEXT, PRIMARY KEY ("table", "row"))`,
    );
    for (const tables of this.#tables.values()) {
      for (const table of tables.values()) {
        const target = `main.${quoteSqliteIdentifier(table.sqlName)}`;
        const name = (event: string) => quoteSqliteIdentifier(`lofi_zql_${event}_${table.sqlName}`);
        const internalId = quoteSqliteIdentifier("_internalId");
        const before = `json_array(${Object.keys(table.columns)
          .map((column) => `OLD.${quoteSqliteIdentifier(column)}`)
          .join(", ")})`;
        // Only a row's first change since IVM caught up holds its earlier values. The trigger checks
        // for an earlier one rather than using OR IGNORE, which an outer upsert's conflict handling
        // overrides, failing the replica's second write of a row in one batch.
        const record = (row: string, values: string) =>
          `INSERT INTO ${CHANGES_TABLE} SELECT ${sqlString(table.sqlName)}, ${row}, ${values} WHERE NOT EXISTS (SELECT 1 FROM ${CHANGES_TABLE} WHERE "table" = ${sqlString(table.sqlName)} AND "row" = ${row})`;
        this.#run(
          `CREATE TEMP TRIGGER IF NOT EXISTS ${name("insert")} AFTER INSERT ON ${target} BEGIN ${record(`NEW.${internalId}`, "NULL")}; END`,
        );
        this.#run(
          `CREATE TEMP TRIGGER IF NOT EXISTS ${name("update")} AFTER UPDATE ON ${target} BEGIN ${record(`OLD.${internalId}`, before)}; END`,
        );
        this.#run(
          `CREATE TEMP TRIGGER IF NOT EXISTS ${name("delete")} AFTER DELETE ON ${target} BEGIN ${record(`OLD.${internalId}`, before)}; END`,
        );
      }
    }
  }

  #pushRecordedChanges(): void {
    const recorded = this.#database
      .prepare(`SELECT "table", "row", "before" FROM ${CHANGES_TABLE}`)
      .all<{ table: string; row: number | bigint; before: string | null }>();
    if (recorded.length === 0) {
      return;
    }
    this.#run(`DELETE FROM ${CHANGES_TABLE}`);

    // Rows are recorded by `_internalId`, but IVM keys them by `id`, which a row deleted and
    // created again since IVM caught up keeps under a new `_internalId`.
    const touched = new Map<
      TableSource,
      { table: ZqlTable; before: Map<string, Row | undefined> }
    >();
    for (const { table: sqlName, row: internalId, before } of recorded) {
      const source = this.#sources.get(sqlName);
      if (!source) {
        // No view reads the table; a later view reads its current rows.
        continue;
      }
      const table = this.#tablesBySqlName.get(sqlName)!;
      let rows = touched.get(source);
      if (!rows) {
        rows = { table, before: new Map() };
        touched.set(source, rows);
      }
      if (before !== null) {
        const row = fromSQLiteRawRow(
          table.rawColumns,
          JSON.parse(before) as SQLiteValue[],
          sqlName,
        );
        rows.before.set(row[table.primaryKey[0]] as string, row);
        continue;
      }
      const created = readRow(table, table.readByInternalId, internalId);
      const id = created?.[table.primaryKey[0]] as string | undefined;
      // A row created and deleted again since IVM caught up never existed for IVM.
      if (id !== undefined && !rows.before.has(id)) {
        rows.before.set(id, undefined);
      }
    }

    const pushes: Array<[TableSource, SourceChange]> = [];
    for (const [source, { table, before }] of touched) {
      const rewound: Array<readonly [Row, Row | undefined]> = [];
      for (const [id, beforeRow] of before) {
        const afterRow = readRow(table, table.readById, id);
        const change =
          beforeRow === undefined
            ? afterRow && makeSourceChangeAdd(afterRow)
            : afterRow === undefined
              ? makeSourceChangeRemove(beforeRow)
              : makeSourceChangeEdit(afterRow, beforeRow);
        if (change) {
          rewound.push([(afterRow ?? beforeRow)!, beforeRow]);
          pushes.push([source, change]);
        }
      }
      source.restoreRowsBeforeBatch(rewound);
    }
    // Every source is rewound before the first push, since a push reads other tables too.
    for (const [source, change] of pushes) {
      consume(source.push(change));
    }
    for (const source of touched.keys()) {
      source.setDB(this.#database);
    }
    for (const view of this.#views.values()) {
      view.flush();
    }
  }

  #run(sql: string): void {
    this.#database.prepare(sql).run();
  }
}

function readRow(table: ZqlTable, statement: Statement, key: unknown): Row | undefined {
  const values = statement.get<SQLiteValue[] | undefined>(key);
  return values === undefined
    ? undefined
    : fromSQLiteRawRow(table.rawColumns, values, table.sqlName);
}

function selectList(columns: Record<string, SchemaValue>): string {
  return Object.keys(columns).map(quoteSqliteIdentifier).join(", ");
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
