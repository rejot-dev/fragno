import { sql } from "kysely";
import {
  type ColumnOperation,
  isUpdated,
  type MigrationOperation,
} from "../../../migration-engine/shared";
import type { TableNameMapper } from "../../shared/table-name-mapper";
import {
  BaseMigrationExecutor,
  createUniqueIndex,
  dropUniqueIndex,
  type ExecuteNode,
  getForeignKeyAction,
} from "./execute-base";

const errors = {
  IdColumnUpdate:
    "ID columns cannot be updated. Not every database supports updating primary keys and often requires workarounds.",
} as const;

/**
 * MySQL-specific migration executor.
 * Uses modifyColumn for updates and "no action" for FK actions (RESTRICT not supported).
 */
export class MysqlMigrationExecutor extends BaseMigrationExecutor {
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
    return this.db.schema
      .alterTable(this.getTableName(operation.from, mapper))
      .renameTo(this.getTableName(operation.to, mapper));
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

        // MySQL: Use modifyColumn which requires the full column definition
        results.push(
          next().modifyColumn(
            operation.name,
            sql.raw(this.getDBType(col)),
            this.getColumnBuilderCallback(col),
          ),
        );

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
    // MySQL doesn't support IF EXISTS for dropping constraints
    return this.db.schema.alterTable(this.getTableName(table, mapper)).dropConstraint(name);
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
