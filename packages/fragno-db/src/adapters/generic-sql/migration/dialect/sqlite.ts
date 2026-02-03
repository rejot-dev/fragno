import { type ColumnDefinitionBuilder, type CompiledQuery, type RawBuilder, sql } from "kysely";
import type {
  ColumnInfo,
  ColumnOperation,
  ForeignKeyInfo,
  MigrationOperation,
} from "../../../../migration-engine/shared";
import type { NamingResolver } from "../../../../naming/sql-naming";
import { SQLGenerator } from "../sql-generator";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CreateTableBuilderAny = any;

/**
 * Metadata attached to create-table operations for inline foreign keys.
 */
interface SqliteCreateTableMetadata {
  [key: string]: unknown;
  inlineForeignKeys?: ForeignKeyInfo[];
}

const errors = {
  IdColumnUpdate:
    "ID columns cannot be updated. Not every database supports updating primary keys and often requires workarounds.",
  SQLiteUpdateColumn: "SQLite doesn't support updating columns. Recreate the table instead.",
  SQLiteUpdateForeignKeys:
    "SQLite doesn't support modifying foreign keys directly. Use `recreate-table` instead.",
} as const;

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
   * SQLite doesn't support updating columns.
   */
  protected override compileUpdateColumn(
    _tableName: string,
    _logicalTableName: string,
    operation: Extract<ColumnOperation, { type: "update-column" }>,
    _resolver?: NamingResolver,
  ): CompiledQuery | CompiledQuery[] {
    const col = operation.value;
    if (col.role === "external-id" || col.role === "internal-id") {
      throw new Error(errors.IdColumnUpdate);
    }
    throw new Error(errors.SQLiteUpdateColumn);
  }
}
