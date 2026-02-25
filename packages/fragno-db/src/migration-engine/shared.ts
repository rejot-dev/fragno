export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
}

/**
 * Provider-specific metadata that can be attached to operations during preprocessing.
 * This allows providers to add additional context without polluting the core operation types.
 */
export interface MigrationOperationMetadata {
  [key: string]: unknown;
}

/**
 * SQLite-specific metadata for create-table operations.
 * Includes foreign keys that should be created inline with the table.
 */
export interface SqliteCreateTableMetadata extends MigrationOperationMetadata {
  inlineForeignKeys?: ForeignKeyInfo[];
}

export interface ColumnInfo {
  name: string;
  type:
    | "string"
    | "integer"
    | "bigint"
    | "decimal"
    | "bool"
    | "date"
    | "timestamp"
    | "json"
    | "binary"
    | `varchar(${number})`;
  isNullable: boolean;
  role: "external-id" | "internal-id" | "version" | "reference" | "regular";
  default?: { value: unknown } | { dbSpecial: "now" } | { runtime: "cuid" | "now" };
}

export interface SqliteRecreateTableInfo {
  columns: ColumnInfo[];
  copyColumns: SqliteCopyColumn[];
  indexes: { name: string; columns: string[]; unique: boolean }[];
  foreignKeys: ForeignKeyInfo[];
}

export type SqliteCopyColumn = string | { from: string; to: string };

export interface SqliteAlterTableMetadata extends MigrationOperationMetadata {
  recreateTable?: SqliteRecreateTableInfo;
}

export type MigrationOperation<
  TMeta extends MigrationOperationMetadata = MigrationOperationMetadata,
> =
  | (TableOperation & { metadata?: TMeta })
  | ({
      // warning: not supported by SQLite
      type: "add-foreign-key";
      table: string;
      value: ForeignKeyInfo;
    } & { metadata?: TMeta })
  | ({
      // warning: not supported by SQLite
      type: "drop-foreign-key";
      table: string;
      name: string;
      referencedTable: string;
    } & { metadata?: TMeta })
  | ({
      type: "drop-index";
      table: string;
      name: string;
    } & { metadata?: TMeta })
  | ({
      type: "add-index";
      table: string;
      columns: string[];
      name: string;
      unique: boolean;
    } & { metadata?: TMeta })
  | (CustomOperation & { metadata?: TMeta });

export type CustomOperation = {
  type: "custom";
} & Record<string, unknown>;

export type TableOperation =
  | {
      type: "create-table";
      name: string;
      columns: ColumnInfo[];
    }
  | {
      type: "drop-table";
      name: string;
    }
  | {
      type: "alter-table";
      name: string;
      value: ColumnOperation[];
    }
  | {
      type: "rename-table";
      from: string;
      to: string;
    };

export type ColumnOperation =
  | {
      type: "rename-column";
      from: string;
      to: string;
    }
  | {
      type: "drop-column";
      name: string;
    }
  | {
      /**
       * Note: unique constraints are not created, please use dedicated operations like `add-index` instead
       */
      type: "create-column";
      value: ColumnInfo;
    }
  | {
      /**
       * warning: Not supported by SQLite
       */
      type: "update-column";
      name: string;
      /**
       * For databases like MySQL, it requires the full definition for any modify column statement.
       * Hence, you need to specify the full information of your column here.
       *
       * Then, opt-in for in-detail modification for other databases that supports changing data type/nullable/default separately, such as PostgreSQL.
       *
       * Note: unique constraints are not updated, please use dedicated operations like `add-index` instead
       */
      value: ColumnInfo;

      updateNullable: boolean;
      updateDefault: boolean;
      updateDataType: boolean;
    };

export function isUpdated(op: Extract<ColumnOperation, { type: "update-column" }>): boolean {
  return op.updateDataType || op.updateDefault || op.updateNullable;
}
