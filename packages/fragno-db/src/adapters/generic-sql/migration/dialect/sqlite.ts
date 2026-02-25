import { type ColumnDefinitionBuilder, type CompiledQuery, type RawBuilder, sql } from "kysely";
import type {
  ColumnInfo,
  ColumnOperation,
  MigrationOperation,
  SqliteAlterTableMetadata,
  SqliteCopyColumn,
  SqliteCreateTableMetadata,
} from "../../../../migration-engine/shared";
import type { NamingResolver } from "../../../../naming/sql-naming";
import { SQLGenerator } from "../sql-generator";
import { createHash } from "node:crypto";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CreateTableBuilderAny = any;

const errors = {
  IdColumnUpdate:
    "ID columns cannot be updated. Not every database supports updating primary keys and often requires workarounds.",
  SQLiteUpdateColumn: "SQLite doesn't support updating columns. Recreate the table instead.",
  SQLiteUpdateForeignKeys:
    "SQLite doesn't support modifying foreign keys directly. Use `recreate-table` instead.",
} as const;

type RenameOrDropColumnOperation = Extract<
  ColumnOperation,
  { type: "rename-column" } | { type: "drop-column" }
>;

type CopyColumnMapping = { from: string; to: string };
type SqliteRecreateTable = NonNullable<SqliteAlterTableMetadata["recreateTable"]>;
type SqliteRecreateIndex = SqliteRecreateTable["indexes"][number];
type SqliteRecreateForeignKey = SqliteRecreateTable["foreignKeys"][number];

function normalizeCopyColumns(copyColumns: SqliteCopyColumn[]): CopyColumnMapping[] {
  return copyColumns.map((column) =>
    typeof column === "string"
      ? { from: column, to: column }
      : { from: column.from, to: column.to },
  );
}

function applyRenameDropToColumns(
  columns: ColumnInfo[],
  operations: RenameOrDropColumnOperation[],
): ColumnInfo[] {
  let next = columns.map((column) => ({ ...column }));

  for (const op of operations) {
    if (op.type === "rename-column") {
      const column = next.find((col) => col.name === op.from);
      if (column) {
        column.name = op.to;
      }
    } else if (op.type === "drop-column") {
      next = next.filter((column) => column.name !== op.name);
    }
  }

  return next;
}

function applyRenameDropToCopyColumns(
  copyColumns: CopyColumnMapping[],
  operations: RenameOrDropColumnOperation[],
): CopyColumnMapping[] {
  let next = copyColumns.map((column) => ({ ...column }));

  for (const op of operations) {
    if (op.type === "rename-column") {
      for (const mapping of next) {
        if (mapping.to === op.from) {
          mapping.to = op.to;
        }
      }
    } else if (op.type === "drop-column") {
      next = next.filter((mapping) => mapping.to !== op.name);
    }
  }

  return next;
}

function applyRenameDropToIndexes(
  indexes: SqliteRecreateIndex[],
  operations: RenameOrDropColumnOperation[],
): SqliteRecreateIndex[] {
  const next: SqliteRecreateIndex[] = [];

  for (const index of indexes) {
    let columns = [...index.columns];
    let dropped = false;

    for (const op of operations) {
      if (op.type === "rename-column") {
        columns = columns.map((column) => (column === op.from ? op.to : column));
      } else if (columns.includes(op.name)) {
        dropped = true;
        break;
      }
    }

    if (!dropped) {
      next.push({ ...index, columns });
    }
  }

  return next;
}

function applyRenameDropToForeignKeys(
  foreignKeys: SqliteRecreateForeignKey[],
  operations: RenameOrDropColumnOperation[],
): SqliteRecreateForeignKey[] {
  const next: SqliteRecreateForeignKey[] = [];

  for (const foreignKey of foreignKeys) {
    let columns = [...foreignKey.columns];
    let dropped = false;

    for (const op of operations) {
      if (op.type === "rename-column") {
        columns = columns.map((column) => (column === op.from ? op.to : column));
      } else if (columns.includes(op.name)) {
        dropped = true;
        break;
      }
    }

    if (!dropped) {
      next.push({
        ...foreignKey,
        columns,
      });
    }
  }

  return next;
}

function mergeRenameDropIntoRecreate(
  recreate: SqliteRecreateTable,
  operations: ColumnOperation[],
): SqliteRecreateTable {
  const renameDropOps = operations.filter(
    (op): op is RenameOrDropColumnOperation =>
      op.type === "rename-column" || op.type === "drop-column",
  );

  if (renameDropOps.length === 0) {
    return recreate;
  }

  return {
    ...recreate,
    columns: applyRenameDropToColumns(recreate.columns, renameDropOps),
    copyColumns: applyRenameDropToCopyColumns(
      normalizeCopyColumns(recreate.copyColumns),
      renameDropOps,
    ),
    indexes: applyRenameDropToIndexes(recreate.indexes, renameDropOps),
    foreignKeys: applyRenameDropToForeignKeys(recreate.foreignKeys, renameDropOps),
  };
}

/**
 * SQLite-specific SQL generator.
 * Handles SQLite's limitations around foreign keys and column updates.
 */
export class SQLiteSQLGenerator extends SQLGenerator {
  /**
   * SQLite preprocessing: merge add-foreign-key operations into create-table operations
   * when both exist in the same batch, and add pragma for deferred foreign keys.
   *
   * SQLite requires foreign keys to be defined at table creation time.
   */
  override preprocess(operations: MigrationOperation[]): MigrationOperation[] {
    if (operations.length === 0) {
      return operations;
    }

    const result: MigrationOperation[] = [];
    const createTableIndices = new Map<string, number>();
    const foreignKeysByTable = new Map<
      string,
      Extract<MigrationOperation, { type: "add-foreign-key" }>[]
    >();

    // First pass: identify create-table operations and collect foreign keys
    for (const op of operations) {
      if (op.type === "create-table") {
        createTableIndices.set(op.name, result.length);
        result.push(op);
      } else if (op.type === "add-foreign-key") {
        if (!foreignKeysByTable.has(op.table)) {
          foreignKeysByTable.set(op.table, []);
        }
        foreignKeysByTable.get(op.table)!.push(op);
      } else {
        result.push(op);
      }
    }

    // Second pass: attach foreign keys as metadata to create-table ops
    for (const [tableName, fkOps] of foreignKeysByTable.entries()) {
      const createTableIdx = createTableIndices.get(tableName);

      if (createTableIdx !== undefined) {
        const createOp = result[createTableIdx];
        if (createOp.type === "create-table") {
          const metadata: SqliteCreateTableMetadata = {
            inlineForeignKeys: fkOps.map((fkOp) => fkOp.value),
          };
          result[createTableIdx] = {
            ...createOp,
            metadata,
          };
        }
      } else {
        // Table already exists - keep add-foreign-key operations (will throw error during compile)
        result.push(...fkOps);
      }
    }

    // Add pragma at the beginning for deferred foreign key checking
    return [{ type: "custom", sql: "PRAGMA defer_foreign_keys = ON" }, ...result];
  }

  override applyAutoIncrement(builder: ColumnDefinitionBuilder): ColumnDefinitionBuilder {
    return builder.autoIncrement();
  }

  override getDefaultValue(column: ColumnInfo): RawBuilder<unknown> | undefined {
    const value = column.default;
    if (!value) {
      return undefined;
    }

    if ("value" in value && value.value !== undefined) {
      return sql.lit(value.value);
    }

    if ("dbSpecial" in value && value.dbSpecial === "now") {
      const dbType = this.typeMapper.getDatabaseType(column);
      if (dbType === "integer" && (column.type === "timestamp" || column.type === "date")) {
        return sql`(cast((julianday('now') - 2440587.5)*86400000 as integer))`;
      }
      return sql`CURRENT_TIMESTAMP`;
    }

    // Runtime defaults are handled in application code, not SQL
    if ("runtime" in value) {
      return undefined;
    }

    return undefined;
  }

  /**
   * Override create-table to add inline foreign keys from metadata.
   */
  protected override compileCreateTable(
    operation: Extract<MigrationOperation, { type: "create-table" }>,
    resolver?: NamingResolver,
  ): CompiledQuery {
    const tableName = this.getTableName(operation.name, resolver);
    let builder: CreateTableBuilderAny = this.getSchemaBuilder(resolver).createTable(tableName);

    // Add columns
    for (const col of operation.columns) {
      const columnName = this.getColumnName(col.name, operation.name, resolver);
      builder = builder.addColumn(
        columnName,
        sql.raw(this.getDBType(col)),
        (b: ColumnDefinitionBuilder) => this.buildColumn(col, b),
      );
    }

    // Add inline foreign keys from metadata
    const metadata = operation.metadata as SqliteCreateTableMetadata | undefined;
    if (metadata?.inlineForeignKeys) {
      for (const fk of metadata.inlineForeignKeys) {
        builder = builder.addForeignKeyConstraint(
          this.getForeignKeyName(fk.name, operation.name, fk.referencedTable, resolver),
          fk.columns.map((columnName) => this.getColumnName(columnName, operation.name, resolver)),
          this.getTableName(fk.referencedTable, resolver),
          fk.referencedColumns.map((columnName) =>
            this.getColumnName(columnName, fk.referencedTable, resolver),
          ),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (cb: any) => cb.onUpdate("restrict").onDelete("restrict"),
        );
      }
    }

    const compiled = builder.compile();
    // SQLite constraint names are ignored by Drizzle migrations; strip them for parity.
    const sqlText = compiled.sql.replace(/\bconstraint\s+"[^"]+"\s+foreign key\b/gi, "foreign key");
    return {
      ...compiled,
      sql: sqlText,
    };
  }

  /**
   * SQLite doesn't support adding foreign keys to existing tables.
   */
  protected override compileAddForeignKey(
    _operation: Extract<MigrationOperation, { type: "add-foreign-key" }>,
    _resolver?: NamingResolver,
  ): CompiledQuery {
    throw new Error(errors.SQLiteUpdateForeignKeys);
  }

  /**
   * SQLite doesn't support dropping foreign keys.
   */
  protected override compileDropForeignKey(
    _operation: Extract<MigrationOperation, { type: "drop-foreign-key" }>,
    _resolver?: NamingResolver,
  ): CompiledQuery {
    throw new Error(errors.SQLiteUpdateForeignKeys);
  }

  /**
   * SQLite doesn't support updating columns directly. Use table recreation when metadata is provided.
   */
  protected override compileAlterTable(
    operation: Extract<MigrationOperation, { type: "alter-table" }>,
    resolver?: NamingResolver,
  ): CompiledQuery[] {
    const hasUpdateColumn = operation.value.some((columnOp) => columnOp.type === "update-column");

    if (!hasUpdateColumn) {
      return super.compileAlterTable(operation, resolver);
    }

    for (const columnOp of operation.value) {
      if (columnOp.type !== "update-column") {
        continue;
      }
      const col = columnOp.value;
      if (col.role === "external-id" || col.role === "internal-id") {
        throw new Error(errors.IdColumnUpdate);
      }
    }

    const metadata = operation.metadata as SqliteAlterTableMetadata | undefined;
    const recreate = metadata?.recreateTable;
    if (!recreate) {
      throw new Error(errors.SQLiteUpdateColumn);
    }

    const mergedRecreate = mergeRenameDropIntoRecreate(recreate, operation.value);
    return this.compileRecreateTable(operation.name, mergedRecreate, resolver);
  }

  protected override compileUpdateColumn(
    _tableName: string,
    _logicalTableName: string,
    _operation: Extract<ColumnOperation, { type: "update-column" }>,
    _resolver?: NamingResolver,
  ): CompiledQuery | CompiledQuery[] {
    throw new Error(errors.SQLiteUpdateColumn);
  }

  private compileRecreateTable(
    logicalTableName: string,
    recreate: NonNullable<SqliteAlterTableMetadata["recreateTable"]>,
    resolver?: NamingResolver,
  ): CompiledQuery[] {
    const queries: CompiledQuery[] = [];
    const tableName = this.getTableName(logicalTableName, resolver);
    const tempTableName = `${tableName}__fragno_tmp_${createHash("md5")
      .update(tableName)
      .digest("hex")
      .slice(0, 6)}`;

    queries.push(this.compileRaw(sql.raw("PRAGMA foreign_keys = OFF")));

    queries.push(
      this.getSchemaBuilder(resolver).alterTable(tableName).renameTo(tempTableName).compile(),
    );

    const createTableOp: MigrationOperation = {
      type: "create-table",
      name: logicalTableName,
      columns: recreate.columns,
      metadata: {
        inlineForeignKeys: recreate.foreignKeys,
      } satisfies SqliteCreateTableMetadata,
    };

    queries.push(this.compileCreateTable(createTableOp, resolver));

    const copyColumns = normalizeCopyColumns(recreate.copyColumns);
    if (copyColumns.length > 0) {
      const targetRefs = copyColumns.map((column) =>
        sql.ref(this.getColumnName(column.to, logicalTableName, resolver)),
      );
      const sourceRefs = copyColumns.map((column) =>
        sql.ref(this.getColumnName(column.from, logicalTableName, resolver)),
      );
      const targetList = sql.join(targetRefs);
      const sourceList = sql.join(sourceRefs);
      queries.push(
        sql`insert into ${sql.ref(tableName)} (${targetList}) select ${sourceList} from ${sql.ref(
          tempTableName,
        )}`.compile(this.db),
      );
    }

    queries.push(this.getSchemaBuilder(resolver).dropTable(tempTableName).compile());

    for (const index of recreate.indexes) {
      const compiled = this.compileAddIndex(
        {
          type: "add-index",
          table: logicalTableName,
          name: index.name,
          columns: index.columns,
          unique: index.unique,
        },
        resolver,
      );
      if (Array.isArray(compiled)) {
        queries.push(...compiled);
      } else {
        queries.push(compiled);
      }
    }

    queries.push(this.compileRaw(sql.raw("PRAGMA foreign_keys = ON")));

    return queries;
  }
}
