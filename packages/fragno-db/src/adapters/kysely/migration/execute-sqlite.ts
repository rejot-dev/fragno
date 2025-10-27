import { sql } from "kysely";
import type {
  ColumnOperation,
  MigrationOperation,
  SqliteCreateTableMetadata,
} from "../../../migration-engine/shared";
import type { TableNameMapper } from "../kysely-shared";
import {
  BaseMigrationExecutor,
  createUniqueIndex,
  dropUniqueIndex,
  type ExecuteNode,
} from "./execute-base";

const errors = {
  IdColumnUpdate:
    "ID columns cannot be updated. Not every database supports updating primary keys and often requires workarounds.",
  SQLiteUpdateColumn: "SQLite doesn't support updating columns. Recreate the table instead.",
  SQLiteUpdateForeignKeys:
    "SQLite doesn't support modifying foreign keys directly. Use `recreate-table` instead.",
} as const;

/**
 * SQLite-specific migration executor.
 * Handles SQLite's limitations around foreign keys and column updates.
 */
export class SqliteMigrationExecutor extends BaseMigrationExecutor<SqliteCreateTableMetadata> {
  /**
   * SQLite preprocessing: merge add-foreign-key operations into create-table operations
   * when both exist in the same batch.
   *
   * SQLite requires foreign keys to be defined at table creation time. This preprocessing
   * step identifies create-table + add-foreign-key pairs and merges them.
   */
  preprocessOperations(
    operations: MigrationOperation[],
  ): MigrationOperation<SqliteCreateTableMetadata>[] {
    const result: MigrationOperation<SqliteCreateTableMetadata>[] = [];
    const createTableIndices = new Map<string, number>(); // table name -> index in result
    const foreignKeysByTable = new Map<string, (typeof operations)[number][]>();

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
        // Table is being created in this batch - attach FKs as metadata
        const createOp = result[createTableIdx];
        if (createOp.type === "create-table") {
          result[createTableIdx] = {
            ...createOp,
            metadata: {
              ...createOp.metadata,
              inlineForeignKeys: fkOps.map((fkOp) => {
                if (fkOp.type === "add-foreign-key") {
                  return fkOp.value;
                }
                throw new Error("Unexpected operation type");
              }),
            },
          };
        }
      } else {
        // Table already exists - keep add-foreign-key operations (will throw error during execution)
        result.push(...fkOps);
      }
    }

    return result;
  }

  executeOperation(
    operation: MigrationOperation<SqliteCreateTableMetadata>,
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
        throw new Error(errors.SQLiteUpdateForeignKeys);
      case "drop-foreign-key":
        throw new Error(errors.SQLiteUpdateForeignKeys);
      case "add-index":
        return this.addIndex(operation, mapper);
      case "drop-index":
        return this.dropIndex(operation, mapper);
      case "custom":
        return this.handleCustomOperation(operation);
    }
  }

  private createTable(
    operation: Extract<MigrationOperation<SqliteCreateTableMetadata>, { type: "create-table" }>,
    mapper?: TableNameMapper,
  ): ExecuteNode {
    const tableName = this.getTableName(operation.name, mapper);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let builder: any = this.db.schema.createTable(tableName);

    // Add columns
    for (const columnInfo of operation.columns) {
      builder = builder.addColumn(
        columnInfo.name,
        sql.raw(this.getDBType(columnInfo)),
        this.getColumnBuilderCallback(columnInfo),
      );
    }

    // Add inline foreign keys from metadata (SQLite-specific)
    const inlineForeignKeys = operation.metadata?.inlineForeignKeys;
    if (inlineForeignKeys) {
      for (const fk of inlineForeignKeys) {
        builder = builder.addForeignKeyConstraint(
          fk.name,
          fk.columns,
          this.getTableName(fk.referencedTable, mapper),
          fk.referencedColumns,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (cb: any) => cb.onUpdate("restrict").onDelete("restrict"),
        );
      }
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
        // Check for ID columns first to provide a more specific error message
        if (col.role === "external-id" || col.role === "internal-id") {
          throw new Error(errors.IdColumnUpdate);
        }
        throw new Error(errors.SQLiteUpdateColumn);
      }
    }
  }

  private dropTable(
    operation: Extract<MigrationOperation, { type: "drop-table" }>,
    mapper?: TableNameMapper,
  ): ExecuteNode {
    return this.db.schema.dropTable(this.getTableName(operation.name, mapper));
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
