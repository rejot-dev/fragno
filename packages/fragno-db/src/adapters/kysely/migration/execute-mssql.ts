import { sql } from "kysely";
import {
  type ColumnOperation,
  isUpdated,
  type MigrationOperation,
} from "../../../migration-engine/shared";
import type { TableNameMapper } from "../kysely-shared";
import {
  BaseMigrationExecutor,
  createUniqueIndex,
  dropUniqueIndex,
  type ExecuteNode,
  getForeignKeyAction,
  getMssqlDefaultConstraintName,
  mssqlDropDefaultConstraint,
} from "./execute-base";

const errors = {
  IdColumnUpdate:
    "ID columns cannot be updated. Not every database supports updating primary keys and often requires workarounds.",
} as const;

/**
 * MSSQL-specific migration executor.
 * Handles complex default constraint management and uses sp_rename for table renames.
 */
export class MssqlMigrationExecutor extends BaseMigrationExecutor {
  executeOperation(
    operation: MigrationOperation,
    mapper?: TableNameMapper,
  ): ExecuteNode | ExecuteNode[] {
    switch (operation.type) {
      case "create-table":
        return this.createTable(operation, mapper);
      case "rename-table":
        return this.renameTable(operation, mapper);
      case "alter-table":
        return this.alterTable(operation, mapper);
      case "drop-table":
        return this.dropTable(operation, mapper);
      case "add-foreign-key":
        return this.addForeignKey(operation, mapper);
      case "drop-foreign-key":
        return this.dropForeignKey(operation, mapper);
      case "add-index":
        return this.addIndex(operation, mapper);
      case "drop-index":
        return this.dropIndex(operation, mapper);
      case "custom":
        return this.handleCustomOperation(operation);
    }
  }

  private createTable(
    operation: Extract<MigrationOperation, { type: "create-table" }>,
    mapper?: TableNameMapper,
  ): ExecuteNode {
    const tableName = this.getTableName(operation.name, mapper);
    let builder = this.db.schema.createTable(tableName);

    // Add columns
    for (const columnInfo of operation.columns) {
      builder = builder.addColumn(
        columnInfo.name,
        sql.raw(this.getDBType(columnInfo)),
        this.getColumnBuilderCallback(columnInfo),
      );
    }

    return builder;
  }

  private renameTable(
    operation: Extract<MigrationOperation, { type: "rename-table" }>,
    mapper?: TableNameMapper,
  ): ExecuteNode {
    // MSSQL uses sp_rename procedure
    return this.rawToNode(
      sql`EXEC sp_rename ${sql.lit(this.getTableName(operation.from, mapper))}, ${sql.lit(this.getTableName(operation.to, mapper))}`,
    );
  }

  private alterTable(
    operation: Extract<MigrationOperation, { type: "alter-table" }>,
    mapper?: TableNameMapper,
  ): ExecuteNode[] {
    const results: ExecuteNode[] = [];
    const tableName = this.getTableName(operation.name, mapper);

    for (const columnOp of operation.value) {
      results.push(...this.executeColumnOperation(tableName, columnOp));
    }

    return results;
  }

  private executeColumnOperation(tableName: string, operation: ColumnOperation): ExecuteNode[] {
    const next = () => this.db.schema.alterTable(tableName);
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
            sql.raw(this.getDBType(col)),
            this.getColumnBuilderCallback(col),
          ),
        );
        return results;
      }

      case "update-column": {
        const col = operation.value;

        if (col.role === "external-id" || col.role === "internal-id") {
          throw new Error(errors.IdColumnUpdate);
        }

        if (!isUpdated(operation)) {
          return results;
        }

        // MSSQL requires dropping and recreating default constraints when changing data type or default value
        const mssqlRecreateDefaultConstraint = operation.updateDataType || operation.updateDefault;

        if (mssqlRecreateDefaultConstraint) {
          results.push(this.rawToNode(mssqlDropDefaultConstraint(tableName, col.name)));
        }

        if (operation.updateDataType) {
          const dbType = sql.raw(this.getDBType(col));
          results.push(next().alterColumn(operation.name, (b) => b.setDataType(dbType)));
        }

        if (operation.updateNullable) {
          results.push(
            next().alterColumn(operation.name, (build) =>
              col.isNullable ? build.dropNotNull() : build.setNotNull(),
            ),
          );
        }

        if (mssqlRecreateDefaultConstraint) {
          const defaultValue = this.defaultValueToDB(col);

          if (defaultValue) {
            const constraintName = getMssqlDefaultConstraintName(tableName, col.name);
            results.push(
              this.rawToNode(
                sql`ALTER TABLE ${sql.ref(tableName)} ADD CONSTRAINT ${sql.ref(constraintName)} DEFAULT ${defaultValue} FOR ${sql.ref(col.name)}`,
              ),
            );
          }
        } else if (operation.updateDefault) {
          const defaultValue = this.defaultValueToDB(col);
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

  private dropTable(
    operation: Extract<MigrationOperation, { type: "drop-table" }>,
    mapper?: TableNameMapper,
  ): ExecuteNode {
    return this.db.schema.dropTable(this.getTableName(operation.name, mapper));
  }

  private addForeignKey(
    operation: Extract<MigrationOperation, { type: "add-foreign-key" }>,
    mapper?: TableNameMapper,
  ): ExecuteNode {
    const { table, value } = operation;
    const action = getForeignKeyAction(this.provider);

    return this.db.schema
      .alterTable(this.getTableName(table, mapper))
      .addForeignKeyConstraint(
        value.name,
        value.columns,
        this.getTableName(value.referencedTable, mapper),
        value.referencedColumns,
        (b) => b.onUpdate(action).onDelete(action),
      );
  }

  private dropForeignKey(
    operation: Extract<MigrationOperation, { type: "drop-foreign-key" }>,
    mapper?: TableNameMapper,
  ): ExecuteNode {
    const { table, name } = operation;
    return this.db.schema
      .alterTable(this.getTableName(table, mapper))
      .dropConstraint(name)
      .ifExists();
  }

  private addIndex(
    operation: Extract<MigrationOperation, { type: "add-index" }>,
    mapper?: TableNameMapper,
  ): ExecuteNode {
    const tableName = this.getTableName(operation.table, mapper);

    if (operation.unique) {
      return createUniqueIndex(
        this.db,
        operation.name,
        tableName,
        operation.columns,
        this.provider,
      );
    }

    return this.db.schema.createIndex(operation.name).on(tableName).columns(operation.columns);
  }

  private dropIndex(
    operation: Extract<MigrationOperation, { type: "drop-index" }>,
    mapper?: TableNameMapper,
  ): ExecuteNode {
    const tableName = this.getTableName(operation.table, mapper);
    return dropUniqueIndex(this.db, operation.name, tableName, this.provider);
  }

  private handleCustomOperation(
    operation: Extract<MigrationOperation, { type: "custom" }>,
  ): ExecuteNode {
    const statement = sql.raw(operation["sql"] as string);
    return this.rawToNode(statement);
  }
}
