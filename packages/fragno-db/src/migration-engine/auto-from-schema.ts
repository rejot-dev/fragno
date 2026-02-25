import {
  type AnySchema,
  type AnyColumn,
  type TableSubOperation,
  type SchemaOperation,
} from "../schema/create";
import type {
  MigrationOperation,
  ColumnInfo,
  ColumnOperation,
  ForeignKeyInfo,
  SqliteAlterTableMetadata,
  SqliteCopyColumn,
} from "./shared";

type IndexInfo = { name: string; columns: string[]; unique: boolean };

type TableState = {
  columns: Record<string, AnyColumn>;
  columnOrder: string[];
  indexes: Record<string, IndexInfo>;
  foreignKeys: ForeignKeyInfo[];
};

function cloneTableState(state: TableState): TableState {
  return {
    columns: { ...state.columns },
    columnOrder: [...state.columnOrder],
    indexes: { ...state.indexes },
    foreignKeys: [...state.foreignKeys],
  };
}

function createTableState(operations: TableSubOperation[]): TableState {
  const state: TableState = {
    columns: {},
    columnOrder: [],
    indexes: {},
    foreignKeys: [],
  };

  for (const subOp of operations) {
    if (subOp.type === "add-column") {
      state.columns[subOp.columnName] = subOp.column;
      state.columnOrder.push(subOp.columnName);
    } else if (subOp.type === "add-index") {
      state.indexes[subOp.name] = {
        name: subOp.name,
        columns: [...subOp.columns],
        unique: subOp.unique,
      };
    }
  }

  return state;
}

function applyTableSubOperations(state: TableState, operations: TableSubOperation[]): void {
  for (const subOp of operations) {
    if (subOp.type === "add-column") {
      if (!state.columns[subOp.columnName]) {
        state.columnOrder.push(subOp.columnName);
      }
      state.columns[subOp.columnName] = subOp.column;
    } else if (subOp.type === "update-column") {
      state.columns[subOp.columnName] = subOp.column;
    } else if (subOp.type === "rename-column") {
      if (state.columns[subOp.from]) {
        state.columns[subOp.to] = state.columns[subOp.from]!;
        delete state.columns[subOp.from];
      }
      const orderIndex = state.columnOrder.indexOf(subOp.from);
      if (orderIndex !== -1) {
        state.columnOrder[orderIndex] = subOp.to;
      }
      state.indexes = renameColumnInIndexes(state.indexes, subOp.from, subOp.to);
      state.foreignKeys = renameColumnInForeignKeys(state.foreignKeys, subOp.from, subOp.to);
    } else if (subOp.type === "drop-column") {
      if (state.columns[subOp.name]) {
        delete state.columns[subOp.name];
      }
      state.columnOrder = state.columnOrder.filter((colName) => colName !== subOp.name);
      state.indexes = dropColumnFromIndexes(state.indexes, subOp.name);
      state.foreignKeys = dropColumnFromForeignKeys(state.foreignKeys, subOp.name);
    } else if (subOp.type === "add-index") {
      state.indexes[subOp.name] = {
        name: subOp.name,
        columns: [...subOp.columns],
        unique: subOp.unique,
      };
    }
  }
}

function renameColumnInIndexes(
  indexes: Record<string, IndexInfo>,
  from: string,
  to: string,
): Record<string, IndexInfo> {
  const next: Record<string, IndexInfo> = {};

  for (const [name, index] of Object.entries(indexes)) {
    if (!index.columns.includes(from)) {
      next[name] = index;
      continue;
    }

    next[name] = {
      ...index,
      columns: index.columns.map((column) => (column === from ? to : column)),
    };
  }

  return next;
}

function dropColumnFromIndexes(
  indexes: Record<string, IndexInfo>,
  columnName: string,
): Record<string, IndexInfo> {
  const next: Record<string, IndexInfo> = {};

  for (const [name, index] of Object.entries(indexes)) {
    if (index.columns.includes(columnName)) {
      continue;
    }
    next[name] = index;
  }

  return next;
}

function renameColumnInForeignKeys(
  foreignKeys: ForeignKeyInfo[],
  from: string,
  to: string,
): ForeignKeyInfo[] {
  return foreignKeys.map((foreignKey) => {
    if (!foreignKey.columns.includes(from)) {
      return foreignKey;
    }

    return {
      ...foreignKey,
      columns: foreignKey.columns.map((column) => (column === from ? to : column)),
    };
  });
}

function dropColumnFromForeignKeys(
  foreignKeys: ForeignKeyInfo[],
  columnName: string,
): ForeignKeyInfo[] {
  return foreignKeys.filter((foreignKey) => !foreignKey.columns.includes(columnName));
}

function buildCopyColumns(
  columnOrder: string[],
  operations: TableSubOperation[],
): SqliteCopyColumn[] {
  const mappings = columnOrder.map((columnName) => ({ from: columnName, to: columnName }));

  for (const op of operations) {
    if (op.type === "rename-column") {
      for (const mapping of mappings) {
        if (mapping.to === op.from) {
          mapping.to = op.to;
        }
      }
    } else if (op.type === "drop-column") {
      for (let i = mappings.length - 1; i >= 0; i -= 1) {
        if (mappings[i]?.to === op.name) {
          mappings.splice(i, 1);
        }
      }
    }
  }

  return mappings;
}

function applyRenameDropToColumnList(
  columns: string[],
  operations: TableSubOperation[],
): string[] | null {
  let next = [...columns];

  for (const op of operations) {
    if (op.type === "rename-column") {
      next = next.map((column) => (column === op.from ? op.to : column));
      continue;
    }

    if (op.type === "drop-column" && next.includes(op.name)) {
      return null;
    }
  }

  return next;
}

function applyReferenceOperation(
  state: TableState,
  operation: Extract<SchemaOperation, { type: "add-reference" }>,
): void {
  state.foreignKeys.push({
    name: operation.referenceName,
    columns: [operation.config.from.column],
    referencedTable: operation.config.to.table,
    referencedColumns: [operation.config.to.column],
  });
}

function buildTableStates(schema: AnySchema, version: number): Map<string, TableState> {
  const tableStates = new Map<string, TableState>();
  const operations = schema.operations.slice(0, version);

  for (const op of operations) {
    if (op.type === "add-table") {
      tableStates.set(op.tableName, createTableState(op.operations));
    } else if (op.type === "alter-table") {
      const state = tableStates.get(op.tableName);
      if (!state) {
        continue;
      }
      applyTableSubOperations(state, op.operations);
    } else if (op.type === "add-reference") {
      const state = tableStates.get(op.tableName);
      if (!state) {
        continue;
      }
      applyReferenceOperation(state, op);
    }
  }

  return tableStates;
}

/**
 * Generate migration operations from a schema's operation history
 *
 * The schema version number represents the cumulative number of operations applied.
 * This function takes operations from the schema between fromVersion and toVersion,
 * and converts them into migration operations.
 *
 * @param targetSchema - The schema containing the operations history
 * @param fromVersion - The current database version (e.g., 0)
 * @param toVersion - The target version to migrate to (e.g., 5)
 * @param options - Migration generation options
 * @returns Array of migration operations to apply
 *
 * @example
 * ```ts
 * const mySchema = schema("my", s => s
 *   .addTable("users", t => t.addColumn("id", idColumn()))       // version 1
 *   .addTable("posts", t => t.addColumn("id", idColumn()))       // version 2
 * );
 *
 * // Generate operations from version 0 to 1 (only creates users table)
 * const operations = generateMigrationFromSchema(mySchema, 0, 1);
 * ```
 */
export function generateMigrationFromSchema(
  targetSchema: AnySchema,
  fromVersion: number,
  toVersion: number,
): MigrationOperation[] {
  if (fromVersion < 0) {
    throw new Error(`fromVersion cannot be negative: ${fromVersion}`);
  }

  if (fromVersion > targetSchema.version) {
    throw new Error(
      `fromVersion (${fromVersion}) exceeds schema version (${targetSchema.version})`,
    );
  }

  if (toVersion > targetSchema.version) {
    throw new Error(`toVersion (${toVersion}) exceeds schema version (${targetSchema.version})`);
  }

  if (toVersion < fromVersion) {
    throw new Error(
      `Cannot migrate backwards: toVersion (${toVersion}) < fromVersion (${fromVersion})`,
    );
  }

  // Get operations between fromVersion and toVersion
  // Operations are 1-indexed (operation 0 is version 0→1)
  const relevantOperations = targetSchema.operations.slice(fromVersion, toVersion);

  // Convert schema operations to migration operations
  const migrationOperations: MigrationOperation[] = [];
  const tableStates = buildTableStates(targetSchema, fromVersion);

  const toColumnInfo = (columnName: string, col: AnyColumn): ColumnInfo => {
    return {
      name: columnName,
      type: col.type,
      isNullable: col.isNullable,
      role: col.role,
      default: col.default
        ? "value" in col.default
          ? { value: col.default.value }
          : "dbSpecial" in col.default
            ? { dbSpecial: col.default.dbSpecial }
            : "runtime" in col.default && typeof col.default.runtime === "string"
              ? { runtime: col.default.runtime }
              : undefined
        : undefined,
    };
  };

  for (const op of relevantOperations) {
    if (op.type === "add-table") {
      // Collect columns for create-table operation
      const columns: ColumnInfo[] = [];

      for (const subOp of op.operations) {
        if (subOp.type === "add-column") {
          columns.push(toColumnInfo(subOp.columnName, subOp.column));
        }
      }

      migrationOperations.push({
        type: "create-table",
        name: op.tableName,
        columns,
      });

      // Add indexes and foreign keys as separate operations
      for (const subOp of op.operations) {
        if (subOp.type === "add-index") {
          migrationOperations.push({
            type: "add-index",
            table: op.tableName,
            name: subOp.name,
            columns: subOp.columns,
            unique: subOp.unique,
          });
        } else if (subOp.type === "add-foreign-key") {
          migrationOperations.push({
            type: "add-foreign-key",
            table: op.tableName,
            value: {
              name: subOp.name,
              columns: subOp.columns,
              referencedTable: subOp.referencedTable,
              referencedColumns: subOp.referencedColumns,
            },
          });
        }
      }

      tableStates.set(op.tableName, createTableState(op.operations));
    } else if (op.type === "alter-table") {
      const columnOps: ColumnOperation[] = [];
      const tableState = tableStates.get(op.tableName);

      for (const subOp of op.operations) {
        if (subOp.type === "add-column") {
          columnOps.push({
            type: "create-column",
            value: toColumnInfo(subOp.columnName, subOp.column),
          });
        } else if (subOp.type === "update-column") {
          columnOps.push({
            type: "update-column",
            name: subOp.columnName,
            value: toColumnInfo(subOp.columnName, subOp.column),
            updateNullable: subOp.updateNullable,
            updateDefault: subOp.updateDefault,
            updateDataType: subOp.updateDataType,
          });
        } else if (subOp.type === "rename-column") {
          columnOps.push({
            type: "rename-column",
            from: subOp.from,
            to: subOp.to,
          });
        } else if (subOp.type === "drop-column") {
          columnOps.push({
            type: "drop-column",
            name: subOp.name,
          });
        }
      }

      if (columnOps.length > 0) {
        const hasUpdateColumn = columnOps.some((colOp) => colOp.type === "update-column");
        const alterTableOperation: MigrationOperation = {
          type: "alter-table",
          name: op.tableName,
          value: columnOps,
        };

        if (hasUpdateColumn) {
          if (!tableState) {
            throw new Error(`Table ${op.tableName} not found in schema state`);
          }

          const nextState = cloneTableState(tableState);
          applyTableSubOperations(nextState, op.operations);

          const metadata: SqliteAlterTableMetadata = {
            recreateTable: {
              columns: nextState.columnOrder.map((colName) =>
                toColumnInfo(colName, nextState.columns[colName]!),
              ),
              copyColumns: buildCopyColumns(tableState.columnOrder, op.operations),
              indexes: Object.values(tableState.indexes).flatMap((idx) => {
                const columns = applyRenameDropToColumnList(idx.columns, op.operations);
                if (!columns) {
                  return [];
                }
                return [
                  {
                    name: idx.name,
                    columns,
                    unique: idx.unique,
                  },
                ];
              }),
              foreignKeys: tableState.foreignKeys.flatMap((fk) => {
                const columns = applyRenameDropToColumnList(fk.columns, op.operations);
                if (!columns) {
                  return [];
                }
                return [
                  {
                    name: fk.name,
                    columns,
                    referencedTable: fk.referencedTable,
                    referencedColumns: [...fk.referencedColumns],
                  },
                ];
              }),
            },
          };

          alterTableOperation.metadata = metadata;
        }

        migrationOperations.push(alterTableOperation);
      }

      // Add indexes as separate operations
      for (const subOp of op.operations) {
        if (subOp.type === "add-index") {
          migrationOperations.push({
            type: "add-index",
            table: op.tableName,
            name: subOp.name,
            columns: subOp.columns,
            unique: subOp.unique,
          });
        }
      }

      if (tableState) {
        const nextState = cloneTableState(tableState);
        applyTableSubOperations(nextState, op.operations);
        tableStates.set(op.tableName, nextState);
      }
    } else if (op.type === "add-reference") {
      if (!op.referenceName || op.referenceName.trim().length === 0) {
        throw new Error(`referenceName is required for add-reference on ${op.tableName}`);
      }
      migrationOperations.push({
        type: "add-foreign-key",
        table: op.tableName,
        value: {
          name: op.referenceName,
          columns: [op.config.from.column],
          referencedTable: op.config.to.table,
          referencedColumns: [op.config.to.column],
        },
      });

      const tableState = tableStates.get(op.tableName);
      if (tableState) {
        applyReferenceOperation(tableState, op);
      }
    }
  }

  return migrationOperations;
}
