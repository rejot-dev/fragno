export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
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
  role: "id" | "reference" | "regular";
  default?: {
    value?: unknown;
    runtime?: "now" | "auto";
  };
}

export type MigrationOperation =
  | TableOperation
  | {
      // warning: not supported by SQLite
      type: "add-foreign-key";
      table: string;
      value: ForeignKeyInfo;
    }
  | {
      // warning: not supported by SQLite
      type: "drop-foreign-key";
      table: string;
      name: string;
    }
  | {
      type: "drop-index";
      table: string;
      name: string;
    }
  | {
      type: "add-index";
      table: string;
      columns: string[];
      name: string;
      unique: boolean;
    }
  | CustomOperation;

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
