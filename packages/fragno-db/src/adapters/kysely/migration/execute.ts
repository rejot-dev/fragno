import {
  type ColumnBuilderCallback,
  type Compilable,
  type CreateTableBuilder,
  type Kysely,
  type RawBuilder,
  sql,
} from "kysely";
import {
  type CustomOperation,
  isUpdated,
  type ColumnOperation,
  type MigrationOperation,
} from "../../../migration-engine/shared";
import type { SQLProvider } from "../../../shared/providers";
import { type AnyColumn, type AnyTable, compileForeignKey, IdColumn } from "../../../schema/create";
import { schemaToDBType } from "../../../schema/serialize";
import type { KyselyConfig } from "../kysely-adapter";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KyselyAny = Kysely<any>;

export type ExecuteNode = Compilable & {
  execute(): Promise<unknown>;
};

const errors = {
  IdColumnUpdate:
    "ID columns cannot be updated. Not every database supports updating primary keys and often requires workarounds.",
  SQLiteUpdateColumn: "SQLite doesn't support updating columns. Recreate the table instead.",
  SQLiteUpdateForeignKeys:
    "SQLite doesn't support modifying foreign keys directly. Use `recreate-table` instead.",
} as const;

/**
 * Returns the appropriate foreign key action based on the provider.
 * MSSQL doesn't support RESTRICT, so we use NO ACTION (functionally equivalent).
 */
function getForeignKeyAction(provider: SQLProvider): "restrict" | "no action" {
  return provider === "mssql" ? "no action" : "restrict";
}

/**
 * Generates MSSQL default constraint name following the DF_tableName_columnName pattern.
 */
function getMssqlDefaultConstraintName(tableName: string, columnName: string): string {
  const MSSQL_DEFAULT_CONSTRAINT_PREFIX = "DF" as const;
  return `${MSSQL_DEFAULT_CONSTRAINT_PREFIX}_${tableName}_${columnName}`;
}

function createUniqueIndex(
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

function dropUniqueIndex(db: KyselyAny, name: string, tableName: string, provider: SQLProvider) {
  let query = db.schema.dropIndex(name).ifExists();

  if (provider === "cockroachdb") {
    query = query.cascade();
  }

  if (provider === "mssql") {
    query = query.on(tableName);
  }

  return query;
}

function executeColumn(
  tableName: string,
  operation: ColumnOperation,
  config: KyselyConfig,
): ExecuteNode[] {
  const { db, provider } = config;
  const next = () => db.schema.alterTable(tableName);
  const results: ExecuteNode[] = [];

  switch (operation.type) {
    case "rename-column":
      results.push(next().renameColumn(operation.from, operation.to));
      return results;

    case "drop-column":
      results.push(next().dropColumn(operation.name));

      return results;
    case "create-column": {
      const col = operation.value;

      results.push(
        next().addColumn(
          col.name,
          sql.raw(schemaToDBType(col, provider)),
          getColumnBuilderCallback(col, provider),
        ),
      );

      return results;
    }
    case "update-column": {
      const col = operation.value;

      if (col instanceof IdColumn) {
        throw new Error(errors.IdColumnUpdate);
      }
      if (provider === "sqlite") {
        throw new Error(errors.SQLiteUpdateColumn);
      }

      if (!isUpdated(operation)) {
        return results;
      }
      if (provider === "mysql") {
        results.push(
          next().modifyColumn(
            operation.name,
            sql.raw(schemaToDBType(col, provider)),
            getColumnBuilderCallback(col, provider),
          ),
        );
        return results;
      }

      // MSSQL requires dropping and recreating default constraints when changing data type or default value
      const mssqlRecreateDefaultConstraint = operation.updateDataType || operation.updateDefault;

      if (provider === "mssql" && mssqlRecreateDefaultConstraint) {
        results.push(rawToNode(db, mssqlDropDefaultConstraint(tableName, col.name)));
      }

      if (operation.updateDataType) {
        const dbType = sql.raw(schemaToDBType(col, provider));

        if (provider === "postgresql" || provider === "cockroachdb") {
          // PostgreSQL/CockroachDB: Use explicit USING clause for type conversion
          results.push(
            rawToNode(
              db,
              sql`ALTER TABLE ${sql.ref(tableName)} ALTER COLUMN ${sql.ref(operation.name)} TYPE ${dbType} USING (${sql.ref(operation.name)}::${dbType})`,
            ),
          );
        } else {
          results.push(next().alterColumn(operation.name, (b) => b.setDataType(dbType)));
        }
      }

      if (operation.updateNullable) {
        results.push(
          next().alterColumn(operation.name, (build) =>
            col.isNullable ? build.dropNotNull() : build.setNotNull(),
          ),
        );
      }

      if (provider === "mssql" && mssqlRecreateDefaultConstraint) {
        const defaultValue = defaultValueToDB(col, provider);

        if (defaultValue) {
          const constraintName = getMssqlDefaultConstraintName(tableName, col.name);

          results.push(
            rawToNode(
              db,
              sql`ALTER TABLE ${sql.ref(tableName)} ADD CONSTRAINT ${sql.ref(constraintName)} DEFAULT ${defaultValue} FOR ${sql.ref(col.name)}`,
            ),
          );
        }
      } else if (operation.updateDefault) {
        const defaultValue = defaultValueToDB(col, provider);

        results.push(
          next().alterColumn(operation.name, (build) => {
            if (!defaultValue) {
              return build.dropDefault();
            }
            return build.setDefault(defaultValue);
          }),
        );
      }

      return results;
    }
  }
}

export function execute(
  operation: MigrationOperation,
  config: KyselyConfig,
  onCustomNode: (op: CustomOperation) => ExecuteNode | ExecuteNode[],
): ExecuteNode | ExecuteNode[] {
  const { db, provider } = config;

  function createTable(table: AnyTable, tableName = table.name, sqliteDeferChecks = false) {
    const results: ExecuteNode[] = [];
    let builder = db.schema.createTable(tableName) as CreateTableBuilder<string, string>;

    for (const col of Object.values(table.columns)) {
      builder = builder.addColumn(
        col.name,
        sql.raw(schemaToDBType(col, provider)),
        getColumnBuilderCallback(col, provider),
      );
    }

    for (const foreignKey of table.foreignKeys) {
      const compiled = compileForeignKey(foreignKey, "sql");
      const action = getForeignKeyAction(provider);

      builder = builder.addForeignKeyConstraint(
        compiled.name,
        compiled.columns,
        compiled.referencedTable,
        compiled.referencedColumns,
        (b) => {
          const fkBuilder = b.onUpdate(action).onDelete(action);

          // SQLite: defer foreign key checks during table recreation
          if (sqliteDeferChecks) {
            return fkBuilder.deferrable().initiallyDeferred();
          }
          return fkBuilder;
        },
      );
    }

    for (const idx of table.indexes) {
      if (idx.unique) {
        results.push(
          createUniqueIndex(
            db,
            idx.name,
            table.name,
            idx.columns.map((col) => col.name),
            provider,
          ),
        );
      }
    }

    results.unshift(builder);
    return results;
  }

  switch (operation.type) {
    case "create-table":
      return createTable(operation.value);
    case "rename-table":
      if (provider === "mssql") {
        return rawToNode(
          db,
          sql`EXEC sp_rename ${sql.lit(operation.from)}, ${sql.lit(operation.to)}`,
        );
      }

      return db.schema.alterTable(operation.from).renameTo(operation.to);
    case "alter-table": {
      const results: ExecuteNode[] = [];

      for (const op of operation.value) {
        results.push(...executeColumn(operation.name, op, config));
      }

      return results;
    }
    case "drop-table":
      return db.schema.dropTable(operation.name);
    case "custom":
      return onCustomNode(operation);
    case "add-foreign-key": {
      if (provider === "sqlite") {
        throw new Error(errors.SQLiteUpdateForeignKeys);
      }

      const { table, value } = operation;
      const action = getForeignKeyAction(provider);

      return db.schema
        .alterTable(table)
        .addForeignKeyConstraint(
          value.name,
          value.columns,
          value.referencedTable,
          value.referencedColumns,
          (b) => b.onUpdate(action).onDelete(action),
        );
    }
    case "drop-foreign-key": {
      if (provider === "sqlite") {
        throw new Error(errors.SQLiteUpdateForeignKeys);
      }

      const { table, name } = operation;
      let query = db.schema.alterTable(table).dropConstraint(name);

      // MySQL doesn't support IF EXISTS for dropping constraints
      if (provider !== "mysql") {
        query = query.ifExists();
      }

      return query;
    }
    case "add-index": {
      if (operation.unique) {
        return createUniqueIndex(db, operation.name, operation.table, operation.columns, provider);
      }
      return db.schema.createIndex(operation.name).on(operation.table).columns(operation.columns);
    }
    case "drop-index": {
      return dropUniqueIndex(db, operation.name, operation.table, provider);
    }
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function getColumnBuilderCallback(col: AnyColumn, provider: SQLProvider): ColumnBuilderCallback {
  return (build) => {
    if (!col.isNullable) {
      build = build.notNull();
    }
    if (col instanceof IdColumn) {
      build = build.primaryKey();
    }

    const defaultValue = defaultValueToDB(col, provider);
    if (defaultValue) {
      build = build.defaultTo(defaultValue);
    }
    return build;
  };
}

function rawToNode(db: KyselyAny, raw: RawBuilder<unknown>): ExecuteNode {
  return {
    compile() {
      return raw.compile(db);
    },
    execute() {
      return raw.execute(db);
    },
  };
}

function mssqlDropDefaultConstraint(tableName: string, columnName: string) {
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

function defaultValueToDB(column: AnyColumn, provider: SQLProvider) {
  const value = column.default;
  if (!value) {
    return undefined;
  }

  // MySQL doesn't support default values for TEXT columns
  if (provider === "mysql" && column.type === "string") {
    return undefined;
  }

  if ("runtime" in value && value.runtime === "now") {
    return sql`CURRENT_TIMESTAMP`;
  }

  if ("value" in value) {
    return sql.lit(value.value);
  }

  return undefined;
}
