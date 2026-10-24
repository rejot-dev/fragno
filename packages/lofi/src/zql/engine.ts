import { LogContext } from "@rocicorp/logger";

import { lofiSqliteTableName, quoteSqliteIdentifier, registeredSchemaName } from "../sqlite/layout";
import type { LofiSchemaRegistration } from "../types";
import { lofiZqlSchema } from "./schema";
import type { LogConfig } from "./vendor/otel/src/log-options.ts";
import type { AST } from "./vendor/zero-protocol/src/ast.ts";
import type { Row } from "./vendor/zero-protocol/src/data.ts";
import type { Format } from "./vendor/zero-types/src/format.ts";
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
import { Database, type LofiZqlConnection, type Statement } from "./zqlite-database.ts";

/** One replica table as IVM reads it. */
type ZqlTable = {
  sqlName: string;
  columns: Record<string, SchemaValue>;
  rawColumns: RawColumn[];
  primaryKey: [string];
  readByInternalId: Statement;
  readById: Statement;
};

type ViewSpec = {
  schemaName: string;
  ast: AST;
  format: Format;
  listener: (data: unknown) => void;
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
 * requires: every push must see the database as it was before the change. Writes by other
 * connections are not recorded, so after one, views are built again.
 */
export class LofiZqlEngine {
  readonly #database: Database;
  readonly #lc = new LogContext("warn");
  /** By registered schema name, then Fragno table name. */
  readonly #tables: Map<string, Map<string, ZqlTable>>;
  readonly #tablesBySqlName: Map<string, ZqlTable>;
  readonly #sources = new Map<string, TableSource>();
  readonly #views = new Map<number, { spec: ViewSpec; view: ArrayView<never> }>();
  /** `PRAGMA data_version` when IVM last caught up, or null before the triggers exist. */
  #dataVersion: number | null = null;

  constructor(connection: LofiZqlConnection, registrations: LofiSchemaRegistration[]) {
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

  /** Builds a view of `ast`, a query on the tables of a registered schema, and reports its data. */
  materialize(id: number, spec: ViewSpec): void {
    this.refresh();
    this.#views.set(id, { spec, view: this.#build(id, spec) });
  }

  destroy(id: number): void {
    this.#views.get(id)?.view.destroy();
    this.#views.delete(id);
  }

  /** Brings every view up to date with the database and reports the data of views that changed. */
  refresh(): void {
    if (this.#dataVersion === null) {
      this.#recordChanges();
      this.#dataVersion = this.#readDataVersion();
      return;
    }
    const dataVersion = this.#readDataVersion();
    if (dataVersion !== this.#dataVersion) {
      this.#dataVersion = dataVersion;
      this.#rebuildViews();
      return;
    }
    this.#pushRecordedChanges();
  }

  #build(id: number, spec: ViewSpec): ArrayView<never> {
    const tables = this.#tables.get(spec.schemaName);
    if (!tables) {
      throw new Error(`Schema "${spec.schemaName}" is not registered with the replica.`);
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
    const input = buildPipeline(spec.ast, delegate, String(id));
    const view = new ArrayView<never>(input, spec.format, true, () => {});
    view.onDestroy = () => {
      input.destroy();
    };
    view.addListener((data) => {
      spec.listener(data);
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

  #rebuildViews(): void {
    this.#run(`DELETE FROM ${CHANGES_TABLE}`);
    const views = [...this.#views];
    for (const [, { view }] of views) {
      view.destroy();
    }
    this.#sources.clear();
    for (const [id, { spec }] of views) {
      this.#views.set(id, { spec, view: this.#build(id, spec) });
    }
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
        // Only a row's first change since IVM caught up holds its earlier values.
        const record = (row: string, values: string) =>
          `INSERT OR IGNORE INTO ${CHANGES_TABLE} VALUES (${sqlString(table.sqlName)}, ${row}, ${values})`;
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
    for (const { view } of this.#views.values()) {
      view.flush();
    }
  }

  #readDataVersion(): number {
    const [row] = this.#database.prepare("PRAGMA data_version").raw(true).all<SQLiteValue[]>();
    return Number(row?.[0]);
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

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
