import { type ColumnDefinitionBuilder, type CompiledQuery, type RawBuilder, sql } from "kysely";
import type {
  ColumnInfo,
  ColumnOperation,
  MigrationOperation,
} from "../../../../migration-engine/shared";
import { isUpdated } from "../../../../migration-engine/shared";
import type { TableNameMapper } from "../../../kysely/kysely-shared";
import { SQLGenerator } from "../sql-generator";

const errors = {
  IdColumnUpdate:
    "ID columns cannot be updated. Not every database supports updating primary keys and often requires workarounds.",
} as const;

/**
 * MySQL-specific SQL generator.
 * Uses modifyColumn for updates and wraps migrations with FK checks disabled.
 */
export class MySQLSQLGenerator extends SQLGenerator {
  /**
   * MySQL preprocessing: wrap operations with SET FOREIGN_KEY_CHECKS = 0/1.
   */
  override preprocess(operations: MigrationOperation[]): MigrationOperation[] {
    if (operations.length === 0) {
      return operations;
    }

    return [
      { type: "custom", sql: "SET FOREIGN_KEY_CHECKS = 0" },
      ...operations,
      { type: "custom", sql: "SET FOREIGN_KEY_CHECKS = 1" },
    ];
  }

  override applyAutoIncrement(builder: ColumnDefinitionBuilder): ColumnDefinitionBuilder {
    return builder.autoIncrement();
  }

  override getDefaultValue(column: ColumnInfo): RawBuilder<unknown> | undefined {
    const value = column.default;
    if (!value) {
      return undefined;
    }

    // MySQL doesn't support default values for TEXT columns
    if (column.type === "string") {
      return undefined;
    }

    if ("value" in value && value.value !== undefined) {
      return sql.lit(value.value);
    }

    if ("dbSpecial" in value && value.dbSpecial === "now") {
      return sql`CURRENT_TIMESTAMP`;
    }

    // Runtime defaults are handled in application code, not SQL
    if ("runtime" in value) {
      return undefined;
    }

    return undefined;
  }

  /**
   * MySQL update-column uses modifyColumn which requires the full column definition.
   */
  protected override compileUpdateColumn(
    tableName: string,
    operation: Extract<ColumnOperation, { type: "update-column" }>,
  ): CompiledQuery | CompiledQuery[] {
    const col = operation.value;

    if (col.role === "external-id" || col.role === "internal-id") {
      throw new Error(errors.IdColumnUpdate);
    }

    if (!isUpdated(operation)) {
      return [];
    }

    // MySQL: Use modifyColumn which requires the full column definition
    return this.db.schema
      .alterTable(tableName)
      .modifyColumn(operation.name, sql.raw(this.getDBType(col)), (b) => this.buildColumn(col, b))
      .compile();
  }

  /**
   * MySQL doesn't support IF EXISTS for dropping constraints.
   */
  protected override compileDropForeignKey(
    operation: Extract<MigrationOperation, { type: "drop-foreign-key" }>,
    mapper?: TableNameMapper,
  ): CompiledQuery {
    const { table, name } = operation;
    return this.db.schema
      .alterTable(this.getTableName(table, mapper))
      .dropConstraint(name)
      .compile();
  }
}
