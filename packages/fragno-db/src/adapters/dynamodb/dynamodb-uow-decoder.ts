import type { RetrievalOperation, UOWDecoder } from "../../query/unit-of-work/unit-of-work";
import { FragnoId, FragnoReference, type AnySchema, type AnyTable } from "../../schema/create";
import { decodeDynamoDBValue } from "./dynamodb-value-codec";

export type DynamoDBRawResult = DynamoDBRawRow[] | { count: number }[];
export type DynamoDBRawRow = Record<string, unknown>;

const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined;

export class DynamoDBUOWDecoder implements UOWDecoder<DynamoDBRawResult> {
  decode(rawResults: DynamoDBRawResult[], operations: RetrievalOperation<AnySchema>[]): unknown[] {
    if (rawResults.length !== operations.length) {
      throw new Error("rawResults and operations must have the same length");
    }

    return rawResults.map((result, index) => {
      const op = operations[index];
      if (!op) {
        throw new Error("Missing retrieval operation for DynamoDB result.");
      }

      if (op.type === "count") {
        return this.#decodeCount(result);
      }

      return (result as DynamoDBRawRow[]).map((row) => this.#decodeRow(row, op.table));
    });
  }

  #decodeCount(result: DynamoDBRawResult): number {
    const first = (result as { count: number }[])[0];
    return first?.count ?? 0;
  }

  #decodeRow(row: DynamoDBRawRow, table: AnyTable): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    const columnValues: Record<string, unknown> = {};

    for (const [columnName, column] of Object.entries(table.columns)) {
      if (!Object.prototype.hasOwnProperty.call(row, columnName)) {
        continue;
      }
      columnValues[columnName] = decodeDynamoDBValue(row[columnName], column);
    }

    for (const [columnName, column] of Object.entries(table.columns)) {
      if (!Object.prototype.hasOwnProperty.call(columnValues, columnName)) {
        continue;
      }
      if (column.isHidden) {
        continue;
      }

      if (column.role === "external-id" && columnValues["_internalId"] !== undefined) {
        output[columnName] = new FragnoId({
          externalId: columnValues[columnName] as string,
          internalId: columnValues["_internalId"] as bigint,
          version: columnValues["_version"] as number,
        });
        continue;
      }

      if (column.role === "reference") {
        const value = columnValues[columnName];
        output[columnName] = isNullish(value)
          ? null
          : FragnoReference.fromInternal(value as bigint);
        continue;
      }

      output[columnName] = columnValues[columnName];
    }

    return output;
  }
}
