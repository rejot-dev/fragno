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
import {
  FRAGNO_DB_PACKAGE_VERSION_KEY,
  SETTINGS_NAMESPACE,
  SYSTEM_MIGRATION_VERSION_KEY,
  SETTINGS_TABLE_NAME,
} from "../../../fragments/internal-fragment.schema";
import type { NamingResolver } from "../../../naming/sql-naming";
import type { DriverConfig, SupportedDatabase } from "../driver-config";
import type { SQLiteStorageMode } from "../sqlite-storage";
import { createSQLTypeMapper } from "../../../schema/type-conversion/create-sql-type-mapper";
import { GLOBAL_SHARD_SENTINEL } from "../../../sharding";

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
  protected readonly typeMapper: ReturnType<typeof createSQLTypeMapper>;
  protected readonly driverConfig?: DriverConfig;

  constructor(
    db: KyselyAny,
    database: SupportedDatabase,
    driverConfig?: DriverConfig,
    sqliteStorageMode?: SQLiteStorageMode,
  ) {
    this.db = db;
    this.database = database;
    this.typeMapper = createSQLTypeMapper(database, sqliteStorageMode);
    this.driverConfig = driverConfig;
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
   * Generate SQL for updating a version key in the settings table.
   */
  protected generateSettingsUpdateSQL(
    key: string,
    fromVersion: number,
    toVersion: number,
  ): CompiledQuery {
    if (fromVersion === 0) {
      // Insert new version record
      const id = createHash("md5").update(key).digest("base64url").replace(/=/g, "");
      return this.db
        .insertInto(SETTINGS_TABLE_NAME)
        .values({
          id: sql.lit(id),
          key: sql.lit(key),
          value: sql.lit(toVersion.toString()),
          _shard: sql.lit(GLOBAL_SHARD_SENTINEL),
        })
        .compile();
    }

    // Update existing version record
    return this.db
      .updateTable(SETTINGS_TABLE_NAME)
      .set({
        value: sql.lit(toVersion.toString()),
      })
      .where("key", "=", sql.lit(key))
      .compile();
  }

  /**
   * Generate SQL for upserting a settings key/value pair.
   */
  protected generateSettingsUpsertSQL(key: string, value: string): CompiledQuery {
    const id = createHash("md5").update(key).digest("base64url").replace(/=/g, "");
    const idLiteral = sql.lit(id);
    const keyLiteral = sql.lit(key);
    const valueLiteral = sql.lit(value);
    const shardLiteral = sql.lit(GLOBAL_SHARD_SENTINEL);

    switch (this.database) {
      case "postgresql":
      case "sqlite":
        return sql`
          insert into ${sql.id(SETTINGS_TABLE_NAME)} (${sql.id("id")}, ${sql.id("key")}, ${sql.id("value")}, ${sql.id("_shard")})
          values (${idLiteral}, ${keyLiteral}, ${valueLiteral}, ${shardLiteral})
          on conflict (${sql.id("key")}) do update
            set ${sql.id("value")} = ${valueLiteral}
        `.compile(this.db);
      case "mysql":
        return sql`
          insert into ${sql.id(SETTINGS_TABLE_NAME)} (${sql.id("id")}, ${sql.id("key")}, ${sql.id("value")}, ${sql.id("_shard")})
          values (${idLiteral}, ${keyLiteral}, ${valueLiteral}, ${shardLiteral})
          on duplicate key update ${sql.id("value")} = ${valueLiteral}
        `.compile(this.db);
    }
  }

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
    return this.generateSettingsUpdateSQL(key, fromVersion, toVersion);
  }

  /**
   * Generate SQL for updating the system migration version in the settings table.
   */
  generateSystemMigrationUpdateSQL(
    namespace: string,
    fromVersion: number,
    toVersion: number,
  ): CompiledQuery {
    const key = `${namespace}.${SYSTEM_MIGRATION_VERSION_KEY}`;
    return this.generateSettingsUpdateSQL(key, fromVersion, toVersion);
  }

  /**
   * Generate SQL for updating the fragno-db package version in the settings table.
   */
  generatePackageVersionUpdateSQL(packageVersion: string): CompiledQuery {
    const key = `${SETTINGS_NAMESPACE}.${FRAGNO_DB_PACKAGE_VERSION_KEY}`;
    return this.generateSettingsUpsertSQL(key, packageVersion);
  }

  /**
   * Compile migration operations to SQL statements.
   * This is the main entry point for SQL generation.
   */
  compile(operations: MigrationOperation[], resolver?: NamingResolver): CompiledQuery[] {
    const preprocessed = this.preprocess(operations);
    const queries: CompiledQuery[] = [];

    const schemaName = resolver?.getSchemaName();
    if (schemaName && this.database === "postgresql") {
      queries.push(sql`CREATE SCHEMA IF NOT EXISTS ${sql.id(schemaName)}`.compile(this.db));
    }

    for (const operation of preprocessed) {
      const compiled = this.compileOperation(operation, resolver);
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
    resolver?: NamingResolver,
  ): CompiledQuery | CompiledQuery[] {
    switch (operation.type) {
      case "create-table":
        return this.compileCreateTable(operation, resolver);
      case "rename-table":
        return this.compileRenameTable(operation, resolver);
      case "alter-table":
        return this.compileAlterTable(operation, resolver);
      case "drop-table":
        return this.compileDropTable(operation, resolver);
      case "add-foreign-key":
        return this.compileAddForeignKey(operation, resolver);
      case "drop-foreign-key":
        return this.compileDropForeignKey(operation, resolver);
      case "add-index":
        return this.compileAddIndex(operation, resolver);
      case "drop-index":
        return this.compileDropIndex(operation, resolver);
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
    resolver?: NamingResolver,
  ): CompiledQuery {
    const tableName = this.getTableName(operation.name, resolver);
    let builder: CreateTableBuilderAny = this.getSchemaBuilder(resolver).createTable(tableName);

    for (const col of operation.columns) {
      const columnName = this.getColumnName(col.name, operation.name, resolver);
      builder = builder.addColumn(columnName, sql.raw(this.getDBType(col)), (b) =>
        this.buildColumn(col, b),
      );
    }

    // Allow subclasses to add inline foreign keys
    builder = this.addInlineForeignKeys(builder, operation, resolver);

    return builder.compile();
  }

  /**
   * Hook for subclasses to add inline foreign keys to create-table.
   * SQLite overrides this to add FKs at table creation time.
   */
  protected addInlineForeignKeys(
    builder: CreateTableBuilderAny,
    _operation: Extract<MigrationOperation, { type: "create-table" }>,
    _resolver?: NamingResolver,
  ): CreateTableBuilderAny {
    return builder;
  }

  /**
   * Compile a rename-table operation.
   */
  protected compileRenameTable(
    operation: Extract<MigrationOperation, { type: "rename-table" }>,
    resolver?: NamingResolver,
  ): CompiledQuery {
    return this.getSchemaBuilder(resolver)
      .alterTable(this.getTableName(operation.from, resolver))
      .renameTo(this.getTableName(operation.to, resolver))
      .compile();
  }

  /**
   * Compile an alter-table operation.
   */
  protected compileAlterTable(
    operation: Extract<MigrationOperation, { type: "alter-table" }>,
    resolver?: NamingResolver,
  ): CompiledQuery[] {
    const queries: CompiledQuery[] = [];
    const tableName = this.getTableName(operation.name, resolver);

    for (const columnOp of operation.value) {
      const compiled = this.compileColumnOperation(tableName, operation.name, columnOp, resolver);
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
    logicalTableName: string,
    operation: ColumnOperation,
    resolver?: NamingResolver,
  ): CompiledQuery | CompiledQuery[] {
    const alter = () => this.getSchemaBuilder(resolver).alterTable(tableName);

    switch (operation.type) {
      case "rename-column":
        return alter()
          .renameColumn(
            this.getColumnName(operation.from, logicalTableName, resolver),
            this.getColumnName(operation.to, logicalTableName, resolver),
          )
          .compile();

      case "drop-column":
        return alter()
          .dropColumn(this.getColumnName(operation.name, logicalTableName, resolver))
          .compile();

      case "create-column": {
        const col = operation.value;
        return alter()
          .addColumn(
            this.getColumnName(col.name, logicalTableName, resolver),
            sql.raw(this.getDBType(col)),
            (b) => this.buildColumn(col, b),
          )
          .compile();
      }

      case "update-column":
        return this.compileUpdateColumn(tableName, logicalTableName, operation, resolver);
    }
  }

  /**
   * Compile an update-column operation.
   * Must be implemented by subclasses since each database handles this differently.
   */
  protected abstract compileUpdateColumn(
    tableName: string,
    logicalTableName: string,
    operation: Extract<ColumnOperation, { type: "update-column" }>,
    resolver?: NamingResolver,
  ): CompiledQuery | CompiledQuery[];

  /**
   * Compile a drop-table operation.
   */
  protected compileDropTable(
    operation: Extract<MigrationOperation, { type: "drop-table" }>,
    resolver?: NamingResolver,
  ): CompiledQuery {
    return this.getSchemaBuilder(resolver)
      .dropTable(this.getTableName(operation.name, resolver))
      .compile();
  }

  /**
   * Compile an add-foreign-key operation.
   * Subclasses can throw if not supported (e.g., SQLite).
   */
  protected compileAddForeignKey(
    operation: Extract<MigrationOperation, { type: "add-foreign-key" }>,
    resolver?: NamingResolver,
  ): CompiledQuery {
    const { table, value } = operation;
    return this.getSchemaBuilder(resolver)
      .alterTable(this.getTableName(table, resolver))
      .addForeignKeyConstraint(
        this.getForeignKeyName(value.name, table, value.referencedTable, resolver),
        value.columns.map((columnName) => this.getColumnName(columnName, table, resolver)),
        this.getTableName(value.referencedTable, resolver),
        value.referencedColumns.map((columnName) =>
          this.getColumnName(columnName, value.referencedTable, resolver),
        ),
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
    resolver?: NamingResolver,
  ): CompiledQuery {
    const { table, name, referencedTable } = operation;
    return this.getSchemaBuilder(resolver)
      .alterTable(this.getTableName(table, resolver))
      .dropConstraint(this.getForeignKeyName(name, table, referencedTable, resolver))
      .ifExists()
      .compile();
  }

  /**
   * Compile an add-index operation.
   */
  protected compileAddIndex(
    operation: Extract<MigrationOperation, { type: "add-index" }>,
    resolver?: NamingResolver,
  ): CompiledQuery {
    const tableName = this.getTableName(operation.table, resolver);
    const indexName = this.getIndexName(
      operation.name,
      operation.table,
      resolver,
      operation.unique,
    );
    const columnNames = operation.columns.map((columnName) =>
      this.getColumnName(columnName, operation.table, resolver),
    );
    let builder = this.getSchemaBuilder(resolver)
      .createIndex(indexName)
      .on(tableName)
      .columns(columnNames);

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
    resolver?: NamingResolver,
  ): CompiledQuery {
    const tableName = this.getTableName(operation.table, resolver);
    const indexName = this.getIndexName(operation.name, operation.table, resolver);
    return this.getSchemaBuilder(resolver).dropIndex(indexName).ifExists().on(tableName).compile();
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
  protected getTableName(tableName: string, resolver?: NamingResolver): string {
    if (tableName === SETTINGS_TABLE_NAME) {
      return tableName;
    }
    return resolver ? resolver.getTableName(tableName) : tableName;
  }

  /**
   * Get the physical index name, applying namespace if a mapper is provided.
   * Index names must be globally unique in most databases, so we namespace them
   * to avoid collisions when multiple fragments use the same logical index names.
   */
  protected getIndexName(
    indexName: string,
    tableName: string,
    resolver?: NamingResolver,
    unique?: boolean,
  ): string {
    if (!resolver) {
      return indexName;
    }
    return unique
      ? resolver.getUniqueIndexName(indexName, tableName)
      : resolver.getIndexName(indexName, tableName);
  }

  protected getForeignKeyName(
    name: string,
    tableName: string,
    referencedTable: string,
    resolver?: NamingResolver,
  ): string {
    if (!resolver) {
      return name;
    }
    return resolver.getForeignKeyName({
      logicalTable: tableName,
      logicalReferencedTable: referencedTable || tableName,
      referenceName: name,
    });
  }

  protected getColumnName(
    columnName: string,
    tableName: string,
    resolver?: NamingResolver,
  ): string {
    return resolver ? resolver.getColumnName(tableName, columnName) : columnName;
  }

  protected getSchemaBuilder(resolver?: NamingResolver) {
    const schemaName = resolver?.getSchemaName();
    return schemaName ? this.db.schema.withSchema(schemaName) : this.db.schema;
  }

  /**
   * Get the database type string for a column.
   */
  protected getDBType(col: ColumnInfo): string {
    return this.typeMapper.getDatabaseType(col);
  }

  /**
   * Compile raw SQL to a CompiledQuery.
   */
  protected compileRaw(raw: RawBuilder<unknown>): CompiledQuery {
    return raw.compile(this.db);
  }
}
