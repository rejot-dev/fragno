import {
  type ColumnDefinitionBuilder,
  type CompiledQuery,
  type CreateTableBuilder,
  type Kysely,
  type RawBuilder,
  sql,
} from "kysely";
import { createHash } from "node:crypto";
import type {
  ColumnInfo,
  ColumnOperation,
  MigrationOperation,
} from "../../../migration-engine/shared";
import { schemaToDBType } from "../../../schema/serialize";
import { SETTINGS_TABLE_NAME } from "../../../fragments/internal-fragment";
import type { TableNameMapper } from "../../kysely/kysely-shared";
import type { SupportedDatabase } from "./cold-kysely";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KyselyAny = Kysely<any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CreateTableBuilderAny = CreateTableBuilder<any, any>;

/**
 * Interface for compiling migration operations to SQL.
 */
export interface CompilableQuery {
  compile(): CompiledQuery;
}

/**
 * Abstract base class for SQL generation from migration operations.
 * Each database dialect extends this class and implements the abstract methods.
 */
export abstract class SQLGenerator {
  protected readonly db: KyselyAny;
  protected readonly database: SupportedDatabase;

  constructor(db: KyselyAny, database: SupportedDatabase) {
    this.db = db;
    this.database = database;
  }

  /**
   * Preprocess operations before SQL generation.
   * Dialects can override to transform operations based on database capabilities.
   * For example, SQLite merges FK operations into create-table operations.
   */
  abstract preprocess(operations: MigrationOperation[]): MigrationOperation[];

  /**
   * Apply auto-increment to a column builder.
   * PostgreSQL uses SERIAL types so this is a no-op there.
   */
  abstract applyAutoIncrement(builder: ColumnDefinitionBuilder): ColumnDefinitionBuilder;

  /**
   * Get the default value for a column, or undefined if not supported.
   * MySQL returns undefined for TEXT columns since it doesn't support defaults there.
   */
  abstract getDefaultValue(column: ColumnInfo): RawBuilder<unknown> | undefined;

  /**
   * Generate SQL for updating the schema version in the settings table.
   * This is the same across all databases.
   */
  generateVersionUpdateSQL(
    namespace: string,
    fromVersion: number,
    toVersion: number,
  ): CompiledQuery {
    const key = `${namespace}.schema_version`;

    if (fromVersion === 0) {
      // Insert new version record
      const id = createHash("md5").update(key).digest("base64url").replace(/=/g, "");
      return this.db
        .insertInto(SETTINGS_TABLE_NAME)
        .values({
          id: sql.lit(id),
          key: sql.lit(key),
          value: sql.lit(toVersion.toString()),
        })
        .compile();
    } else {
      // Update existing version record
      return this.db
        .updateTable(SETTINGS_TABLE_NAME)
        .set({
          value: sql.lit(toVersion.toString()),
        })
        .where("key", "=", sql.lit(key))
        .compile();
    }
  }

  /**
   * Compile migration operations to SQL statements.
   * This is the main entry point for SQL generation.
   */
  compile(operations: MigrationOperation[], mapper?: TableNameMapper): CompiledQuery[] {
    const preprocessed = this.preprocess(operations);
    const queries: CompiledQuery[] = [];

    for (const operation of preprocessed) {
      const compiled = this.compileOperation(operation, mapper);
      if (Array.isArray(compiled)) {
        queries.push(...compiled);
      } else {
        queries.push(compiled);
      }
    }

    return queries;
  }

  /**
   * Compile a single migration operation to SQL.
   */
  protected compileOperation(
    operation: MigrationOperation,
    mapper?: TableNameMapper,
  ): CompiledQuery | CompiledQuery[] {
    switch (operation.type) {
      case "create-table":
        return this.compileCreateTable(operation, mapper);
      case "rename-table":
        return this.compileRenameTable(operation, mapper);
      case "alter-table":
        return this.compileAlterTable(operation, mapper);
      case "drop-table":
        return this.compileDropTable(operation, mapper);
      case "add-foreign-key":
        return this.compileAddForeignKey(operation, mapper);
      case "drop-foreign-key":
        return this.compileDropForeignKey(operation, mapper);
      case "add-index":
        return this.compileAddIndex(operation, mapper);
      case "drop-index":
        return this.compileDropIndex(operation, mapper);
      case "custom":
        return this.compileCustom(operation);
    }
  }

  /**
   * Compile a create-table operation.
   * Subclasses can override to add FK constraints inline (e.g., SQLite).
   */
  protected compileCreateTable(
    operation: Extract<MigrationOperation, { type: "create-table" }>,
    mapper?: TableNameMapper,
  ): CompiledQuery {
    const tableName = this.getTableName(operation.name, mapper);
    let builder: CreateTableBuilderAny = this.db.schema.createTable(tableName);

    for (const col of operation.columns) {
      builder = builder.addColumn(col.name, sql.raw(this.getDBType(col)), (b) =>
        this.buildColumn(col, b),
      );
    }

    // Allow subclasses to add inline foreign keys
    builder = this.addInlineForeignKeys(builder, operation, mapper);

    return builder.compile();
  }

  /**
   * Hook for subclasses to add inline foreign keys to create-table.
   * SQLite overrides this to add FKs at table creation time.
   */
  protected addInlineForeignKeys(
    builder: CreateTableBuilderAny,
    _operation: Extract<MigrationOperation, { type: "create-table" }>,
    _mapper?: TableNameMapper,
  ): CreateTableBuilderAny {
    return builder;
  }

  /**
   * Compile a rename-table operation.
   */
  protected compileRenameTable(
    operation: Extract<MigrationOperation, { type: "rename-table" }>,
    mapper?: TableNameMapper,
  ): CompiledQuery {
    return this.db.schema
      .alterTable(this.getTableName(operation.from, mapper))
      .renameTo(this.getTableName(operation.to, mapper))
      .compile();
  }

  /**
   * Compile an alter-table operation.
   */
  protected compileAlterTable(
    operation: Extract<MigrationOperation, { type: "alter-table" }>,
    mapper?: TableNameMapper,
  ): CompiledQuery[] {
    const queries: CompiledQuery[] = [];
    const tableName = this.getTableName(operation.name, mapper);

    for (const columnOp of operation.value) {
      const compiled = this.compileColumnOperation(tableName, columnOp);
      if (Array.isArray(compiled)) {
        queries.push(...compiled);
      } else {
        queries.push(compiled);
      }
    }

    return queries;
  }

  /**
   * Compile a column operation within an alter-table.
   * Subclasses override for database-specific handling (e.g., MySQL's modifyColumn).
   */
  protected compileColumnOperation(
    tableName: string,
    operation: ColumnOperation,
  ): CompiledQuery | CompiledQuery[] {
    const alter = () => this.db.schema.alterTable(tableName);

    switch (operation.type) {
      case "rename-column":
        return alter().renameColumn(operation.from, operation.to).compile();

      case "drop-column":
        return alter().dropColumn(operation.name).compile();

      case "create-column": {
        const col = operation.value;
        return alter()
          .addColumn(col.name, sql.raw(this.getDBType(col)), (b) => this.buildColumn(col, b))
          .compile();
      }

      case "update-column":
        return this.compileUpdateColumn(tableName, operation);
    }
  }

  /**
   * Compile an update-column operation.
   * Must be implemented by subclasses since each database handles this differently.
   */
  protected abstract compileUpdateColumn(
    tableName: string,
    operation: Extract<ColumnOperation, { type: "update-column" }>,
  ): CompiledQuery | CompiledQuery[];

  /**
   * Compile a drop-table operation.
   */
  protected compileDropTable(
    operation: Extract<MigrationOperation, { type: "drop-table" }>,
    mapper?: TableNameMapper,
  ): CompiledQuery {
    return this.db.schema.dropTable(this.getTableName(operation.name, mapper)).compile();
  }

  /**
   * Compile an add-foreign-key operation.
   * Subclasses can throw if not supported (e.g., SQLite).
   */
  protected compileAddForeignKey(
    operation: Extract<MigrationOperation, { type: "add-foreign-key" }>,
    mapper?: TableNameMapper,
  ): CompiledQuery {
    const { table, value } = operation;
    return this.db.schema
      .alterTable(this.getTableName(table, mapper))
      .addForeignKeyConstraint(
        value.name,
        value.columns,
        this.getTableName(value.referencedTable, mapper),
        value.referencedColumns,
        (b) => b.onUpdate("restrict").onDelete("restrict"),
      )
      .compile();
  }

  /**
   * Compile a drop-foreign-key operation.
   * Subclasses can throw if not supported (e.g., SQLite).
   */
  protected compileDropForeignKey(
    operation: Extract<MigrationOperation, { type: "drop-foreign-key" }>,
    mapper?: TableNameMapper,
  ): CompiledQuery {
    const { table, name } = operation;
    return this.db.schema
      .alterTable(this.getTableName(table, mapper))
      .dropConstraint(name)
      .ifExists()
      .compile();
  }

  /**
   * Compile an add-index operation.
   */
  protected compileAddIndex(
    operation: Extract<MigrationOperation, { type: "add-index" }>,
    mapper?: TableNameMapper,
  ): CompiledQuery {
    const tableName = this.getTableName(operation.table, mapper);
    let builder = this.db.schema
      .createIndex(operation.name)
      .on(tableName)
      .columns(operation.columns);

    if (operation.unique) {
      builder = builder.unique();
    }

    return builder.compile();
  }

  /**
   * Compile a drop-index operation.
   */
  protected compileDropIndex(
    operation: Extract<MigrationOperation, { type: "drop-index" }>,
    mapper?: TableNameMapper,
  ): CompiledQuery {
    const tableName = this.getTableName(operation.table, mapper);
    return this.db.schema.dropIndex(operation.name).ifExists().on(tableName).compile();
  }

  /**
   * Compile a custom SQL operation.
   */
  protected compileCustom(
    operation: Extract<MigrationOperation, { type: "custom" }>,
  ): CompiledQuery {
    // Custom operations have a 'sql' property with raw SQL
    const rawSql = operation["sql"] as string;
    return sql.raw(rawSql).compile(this.db);
  }

  /**
   * Build a column with all its constraints.
   */
  protected buildColumn(
    col: ColumnInfo,
    builder: ColumnDefinitionBuilder,
  ): ColumnDefinitionBuilder {
    if (!col.isNullable) {
      builder = builder.notNull();
    }

    if (col.role === "internal-id") {
      builder = builder.primaryKey();
      builder = this.applyAutoIncrement(builder);
    }

    if (col.role === "external-id") {
      builder = builder.unique();
    }

    const defaultValue = this.getDefaultValue(col);
    if (defaultValue) {
      builder = builder.defaultTo(defaultValue);
    }

    return builder;
  }

  /**
   * Get table name, applying namespace mapping if provided.
   * Settings table is never namespaced.
   */
  protected getTableName(tableName: string, mapper?: TableNameMapper): string {
    if (tableName === SETTINGS_TABLE_NAME) {
      return tableName;
    }
    return mapper ? mapper.toPhysical(tableName) : tableName;
  }

  /**
   * Get the database type string for a column.
   */
  protected getDBType(col: ColumnInfo): string {
    return schemaToDBType(col, this.database);
  }

  /**
   * Compile raw SQL to a CompiledQuery.
   */
  protected compileRaw(raw: RawBuilder<unknown>): CompiledQuery {
    return raw.compile(this.db);
  }
}
