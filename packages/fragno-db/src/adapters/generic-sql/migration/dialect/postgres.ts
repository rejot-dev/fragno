import { type ColumnDefinitionBuilder, type CompiledQuery, type RawBuilder, sql } from "kysely";
import type {
  ColumnInfo,
  ColumnOperation,
  MigrationOperation,
} from "../../../../migration-engine/shared";
import { isUpdated } from "../../../../migration-engine/shared";
import { SQLGenerator } from "../sql-generator";
import type { NamingResolver } from "../../../../naming/sql-naming";

const errors = {
  IdColumnUpdate:
    "ID columns cannot be updated. Not every database supports updating primary keys and often requires workarounds.",
} as const;

/**
 * PostgreSQL-specific SQL generator.
 * Uses USING clauses for type conversion and SERIAL for auto-increment.
 */
export class PostgresSQLGenerator extends SQLGenerator {
  /**
   * PostgreSQL doesn't need preprocessing - it handles FKs normally.
   */
  override preprocess(operations: MigrationOperation[]): MigrationOperation[] {
    return operations;
  }

  /**
   * PostgreSQL uses SERIAL/BIGSERIAL types for auto-increment,
   * which is already handled in PostgreSQLTypeMapper. No builder modification needed.
   */
  override applyAutoIncrement(builder: ColumnDefinitionBuilder): ColumnDefinitionBuilder {
    return builder;
  }

  override getDefaultValue(column: ColumnInfo): RawBuilder<unknown> | undefined {
    const value = column.default;
    if (!value) {
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
   * PostgreSQL update-column uses USING clause for type conversion.
   */
  protected override compileUpdateColumn(
    tableName: string,
    logicalTableName: string,
    operation: Extract<ColumnOperation, { type: "update-column" }>,
    resolver?: NamingResolver,
  ): CompiledQuery | CompiledQuery[] {
    const col = operation.value;

    if (col.role === "external-id" || col.role === "internal-id") {
      throw new Error(errors.IdColumnUpdate);
    }

    if (!isUpdated(operation)) {
      return [];
    }

    const queries: CompiledQuery[] = [];
    const alter = () => this.getSchemaBuilder(resolver).alterTable(tableName);
    const physicalColumnName = this.getColumnName(operation.name, logicalTableName, resolver);

    // PostgreSQL: Use explicit USING clause for type conversion
    if (operation.updateDataType) {
      const dbType = sql.raw(this.getDBType(col));
      queries.push(
        sql`ALTER TABLE ${sql.ref(tableName)} ALTER COLUMN ${sql.ref(physicalColumnName)} TYPE ${dbType} USING (${sql.ref(physicalColumnName)}::${dbType})`.compile(
          this.db,
        ),
      );
    }

    if (operation.updateNullable) {
      queries.push(
        alter()
          .alterColumn(physicalColumnName, (build) =>
            col.isNullable ? build.dropNotNull() : build.setNotNull(),
          )
          .compile(),
      );
    }

    if (operation.updateDefault) {
      const defaultValue = this.getDefaultValue(col);
      queries.push(
        alter()
          .alterColumn(physicalColumnName, (build) => {
            if (!defaultValue) {
              return build.dropDefault();
            }
            return build.setDefault(defaultValue);
          })
          .compile(),
      );
    }

    return queries;
  }
}
