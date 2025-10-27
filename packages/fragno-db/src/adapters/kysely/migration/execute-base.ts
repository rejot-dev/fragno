import { type ColumnBuilderCallback, type Kysely, type RawBuilder, sql } from "kysely";
import type {
  ColumnInfo,
  MigrationOperation,
  MigrationOperationMetadata,
} from "../../../migration-engine/shared";
import type { SQLProvider } from "../../../shared/providers";
import { schemaToDBType } from "../../../schema/serialize";
import type { TableNameMapper } from "../kysely-shared";
import { SETTINGS_TABLE_NAME } from "../../../shared/settings-schema";

export type ExecuteNode = {
  compile(): { sql: string; parameters: readonly unknown[] };
  execute(): Promise<unknown>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KyselyAny = Kysely<any>;

/**
 * Migration executor interface.
 * Each provider implements this to handle database-specific migration execution.
 */
export interface MigrationExecutor<
  TMeta extends MigrationOperationMetadata = MigrationOperationMetadata,
> {
  /**
   * Preprocess operations before execution.
   * Allows executors to combine, split, or transform operations based on provider capabilities.
   *
   * For example, SQLite can merge add-foreign-key operations into create-table operations.
   */
  preprocessOperations(operations: MigrationOperation[]): MigrationOperation<TMeta>[];

  /**
   * Execute a single migration operation.
   */
  executeOperation(
    operation: MigrationOperation<TMeta>,
    mapper?: TableNameMapper,
  ): ExecuteNode | ExecuteNode[];
}

/**
 * Base migration executor with common functionality.
 * Provider-specific executors should extend this class.
 */
export abstract class BaseMigrationExecutor<
  TMeta extends MigrationOperationMetadata = MigrationOperationMetadata,
> implements MigrationExecutor<TMeta>
{
  constructor(
    protected readonly db: KyselyAny,
    protected readonly provider: SQLProvider,
  ) {}

  /**
   * Default implementation: no preprocessing, no metadata.
   * Providers can override to transform operations.
   */
  preprocessOperations(operations: MigrationOperation[]): MigrationOperation<TMeta>[] {
    return operations as MigrationOperation<TMeta>[];
  }

  /**
   * Execute a single migration operation.
   * Must be implemented by provider-specific executors.
   */
  abstract executeOperation(
    operation: MigrationOperation<TMeta>,
    mapper?: TableNameMapper,
  ): ExecuteNode | ExecuteNode[];

  /**
   * Get table name, applying namespace mapping if provided.
   * Settings table is never namespaced.
   */
  protected getTableName(tableName: string, mapper?: TableNameMapper): string {
    return tableName === SETTINGS_TABLE_NAME
      ? tableName
      : mapper
        ? mapper.toPhysical(tableName)
        : tableName;
  }

  /**
   * Get column builder callback for creating/altering columns.
   */
  protected getColumnBuilderCallback(col: ColumnInfo): ColumnBuilderCallback {
    return (build) => {
      if (!col.isNullable) {
        build = build.notNull();
      }

      // Internal ID is the primary key with auto-increment
      if (col.role === "internal-id") {
        build = build.primaryKey();
        // Auto-increment for internal ID
        if (this.provider === "postgresql" || this.provider === "cockroachdb") {
          // SERIAL/BIGSERIAL handles auto-increment
          // Already handled in schemaToDBType
        } else if (this.provider === "mysql") {
          build = build.autoIncrement();
        } else if (this.provider === "sqlite") {
          build = build.autoIncrement();
        } else if (this.provider === "mssql") {
          build = build.identity();
        }
      }

      // External ID must be unique
      if (col.role === "external-id") {
        build = build.unique();
      }

      const defaultValue = this.defaultValueToDB(col);
      if (defaultValue) {
        build = build.defaultTo(defaultValue);
      }
      return build;
    };
  }

  /**
   * Convert column default value to database representation.
   */
  protected defaultValueToDB(column: ColumnInfo): RawBuilder<unknown> | undefined {
    const value = column.default;
    if (!value) {
      return undefined;
    }

    // MySQL doesn't support default values for TEXT columns
    if (this.provider === "mysql" && column.type === "string") {
      return undefined;
    }

    // Static default values: defaultTo(value)
    if ("value" in value && value.value !== undefined) {
      return sql.lit(value.value);
    }

    // Database-level special functions: defaultTo(b => b.now())
    if ("dbSpecial" in value && value.dbSpecial === "now") {
      return sql`CURRENT_TIMESTAMP`;
    }

    // Runtime defaults (defaultTo$) are NOT generated in SQL - they're handled in application code
    if ("runtime" in value) {
      return undefined;
    }

    return undefined;
  }

  /**
   * Wrap a raw SQL builder in an ExecuteNode.
   */
  protected rawToNode(raw: RawBuilder<unknown>): ExecuteNode {
    return {
      compile: () => raw.compile(this.db),
      execute: () => raw.execute(this.db),
    };
  }

  /**
   * Get the database type string for a column.
   */
  protected getDBType(col: ColumnInfo): string {
    return schemaToDBType(col, this.provider);
  }
}

// ============================================================================
// Provider-Specific Helper Functions
// ============================================================================

/**
 * Returns the appropriate foreign key action based on the provider.
 * MSSQL doesn't support RESTRICT, so we use NO ACTION (functionally equivalent).
 */
export function getForeignKeyAction(provider: SQLProvider): "restrict" | "no action" {
  return provider === "mssql" ? "no action" : "restrict";
}

/**
 * Generates MSSQL default constraint name following the DF_tableName_columnName pattern.
 */
export function getMssqlDefaultConstraintName(tableName: string, columnName: string): string {
  const MSSQL_DEFAULT_CONSTRAINT_PREFIX = "DF" as const;
  return `${MSSQL_DEFAULT_CONSTRAINT_PREFIX}_${tableName}_${columnName}`;
}

/**
 * Generate SQL to drop MSSQL default constraint.
 */
export function mssqlDropDefaultConstraint(tableName: string, columnName: string) {
  return sql`
DECLARE @ConstraintName NVARCHAR(200);

SELECT @ConstraintName = dc.name
FROM sys.default_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'dbo' AND t.name = ${sql.lit(tableName)} AND c.name = ${sql.lit(columnName)};

IF @ConstraintName IS NOT NULL
BEGIN
    EXEC('ALTER TABLE [dbo].[' + ${sql.lit(tableName)} + '] DROP CONSTRAINT [' + @ConstraintName + ']');
END`;
}

/**
 * Create a unique index with provider-specific handling.
 */
export function createUniqueIndex(
  db: KyselyAny,
  name: string,
  tableName: string,
  cols: string[],
  provider: SQLProvider,
) {
  const query = db.schema.createIndex(name).on(tableName).columns(cols).unique();

  if (provider === "mssql") {
    // MSSQL: ignore null values in unique indexes by default
    return query.where((b) => {
      return b.and(cols.map((col) => b(col, "is not", null)));
    });
  }

  return query;
}

/**
 * Drop a unique index with provider-specific handling.
 */
export function dropUniqueIndex(
  db: KyselyAny,
  name: string,
  tableName: string,
  provider: SQLProvider,
) {
  let query = db.schema.dropIndex(name).ifExists();

  if (provider === "cockroachdb") {
    query = query.cascade();
  }

  if (provider === "mssql") {
    query = query.on(tableName);
  }

  return query;
}
