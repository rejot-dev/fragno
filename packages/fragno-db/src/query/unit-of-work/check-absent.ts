import type { AnySchema, AnyTable, IdColumn } from "../../schema/create";
import type { Prettify } from "../../util/types";
import type { Condition } from "../condition-builder";

export type CheckAbsentIndexName<TTable extends AnyTable> =
  | "primary"
  | (keyof TTable["indexes"] & string);

type CheckAbsentPrimaryColumnName<TTable extends AnyTable> = {
  [TColumnName in keyof TTable["columns"]]: TTable["columns"][TColumnName] extends IdColumn<
    infer _,
    infer __,
    infer ___
  >
    ? TColumnName
    : never;
}[keyof TTable["columns"]] &
  string;

type CheckAbsentIndexColumnName<
  TTable extends AnyTable,
  TIndexName extends CheckAbsentIndexName<TTable>,
> = TIndexName extends "primary"
  ? CheckAbsentPrimaryColumnName<TTable>
  : TIndexName extends keyof TTable["indexes"]
    ? Extract<TTable["indexes"][TIndexName]["columnNames"][number], keyof TTable["columns"]>
    : never;

export type CheckAbsentIndexValues<
  TTable extends AnyTable,
  TIndexName extends CheckAbsentIndexName<TTable>,
> = Prettify<{
  [TColumnName in CheckAbsentIndexColumnName<TTable, TIndexName>]: Exclude<
    TTable["columns"][TColumnName]["$in"],
    null
  >;
}>;

export function buildCheckAbsentCondition(
  schema: AnySchema,
  tableName: string,
  indexName: string,
  values: Record<string, unknown>,
): { table: AnyTable; condition: Condition; normalizedIndexName: string } {
  const table = schema.tables[tableName];
  if (!table) {
    throw new Error(`Table "${tableName}" not found in schema "${schema.name}".`);
  }

  const isPrimary = indexName === "primary" || indexName === "_primary";
  const normalizedIndexName = isPrimary ? "_primary" : indexName;
  const index = isPrimary ? undefined : table.indexes[indexName];
  if (!isPrimary && !index) {
    throw new Error(`Index "${indexName}" not found on table "${tableName}".`);
  }
  if (index && !index.unique) {
    throw new Error(`checkAbsent() requires a unique index; "${indexName}" is not unique.`);
  }

  const expectedColumns = isPrimary ? [table.getIdColumn().name] : [...index!.columnNames];
  const providedColumns = Object.keys(values);
  const missingColumns = expectedColumns.filter(
    (columnName) => !Object.prototype.hasOwnProperty.call(values, columnName),
  );
  const unexpectedColumns = providedColumns.filter(
    (columnName) => !expectedColumns.includes(columnName),
  );

  if (missingColumns.length > 0 || unexpectedColumns.length > 0) {
    throw new Error(
      `checkAbsent() values for index "${indexName}" must contain exactly: ${expectedColumns.join(", ")}.`,
    );
  }

  const nullishColumn = expectedColumns.find(
    (columnName) => values[columnName] === null || values[columnName] === undefined,
  );
  if (nullishColumn) {
    throw new Error(
      `checkAbsent() requires a non-null value for unique-index column "${nullishColumn}".`,
    );
  }

  const comparisons: Condition[] = expectedColumns.map((columnName) => {
    const column = table.columns[columnName];
    if (!column) {
      throw new Error(
        `Column "${columnName}" from index "${indexName}" not found on table "${tableName}".`,
      );
    }

    return {
      type: "compare",
      a: column,
      operator: "=",
      b: values[columnName],
    };
  });

  if (comparisons.length === 0) {
    throw new Error(`checkAbsent() cannot use the empty index "${indexName}".`);
  }

  return {
    table,
    condition: comparisons.length === 1 ? comparisons[0] : { type: "and", items: comparisons },
    normalizedIndexName,
  };
}
