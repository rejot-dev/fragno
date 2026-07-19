import { Cursor, createCursorFromRecord, type CursorResult } from "../../query/cursor";
import type {
  CompiledQueryTreeChildNode,
  CompiledQueryTreeRootNode,
} from "../../query/unit-of-work/query-tree";
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

      const rows = (result as DynamoDBRawRow[]).map((row) =>
        op.options.queryTree
          ? this.#decodeQueryTreeRow(row, op.options.queryTree)
          : this.#decodeRow(row, op.table),
      );
      if (op.withCursor) {
        return this.#decodeCursorResult(rows, op);
      }
      if (op.withSingleResult) {
        return rows[0] ?? null;
      }
      return rows;
    });
  }

  #decodeCursorResult(
    rows: Record<string, unknown>[],
    operation: Extract<RetrievalOperation<AnySchema>, { type: "find" }>,
  ): CursorResult<unknown> {
    let items = rows;
    let cursor: Cursor | undefined;
    let hasNextPage = false;

    const pageSize = operation.options.pageSize;
    if (pageSize !== undefined && rows.length > pageSize) {
      hasNextPage = true;
      items = rows.slice(0, pageSize);
      const lastItem = items[items.length - 1];
      if (lastItem && operation.options.orderByIndex) {
        const indexColumns = getIndexColumns(
          operation.table,
          operation.options.orderByIndex.indexName,
        );
        const baseCursor = createCursorFromRecord(lastItem, indexColumns, {
          indexName: operation.options.orderByIndex.indexName,
          orderDirection: operation.options.orderByIndex.direction,
          pageSize,
        });
        cursor = new Cursor({
          indexName: baseCursor.indexName,
          orderDirection: baseCursor.orderDirection,
          pageSize: baseCursor.pageSize,
          indexValues: {
            ...baseCursor.indexValues,
            __fragnoExternalId: getExternalIdFromDecodedRow(lastItem, operation.table),
          },
        });
      }
    }

    return { items, cursor, hasNextPage };
  }

  #decodeCount(result: DynamoDBRawResult): number {
    const first = (result as { count: number }[])[0];
    return first?.count ?? 0;
  }

  #decodeQueryTreeRow(
    row: DynamoDBRawRow,
    node: CompiledQueryTreeRootNode | CompiledQueryTreeChildNode,
  ): Record<string, unknown> {
    const output = this.#decodeRow(row, node.table);

    for (const child of node.children) {
      const value = row[child.alias];
      if (child.cardinality === "many") {
        output[child.alias] = Array.isArray(value)
          ? value.map((item) => this.#decodeQueryTreeRow(item as DynamoDBRawRow, child))
          : [];
        continue;
      }

      output[child.alias] =
        value && typeof value === "object"
          ? this.#decodeQueryTreeRow(value as DynamoDBRawRow, child)
          : null;
    }

    return output;
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

function getExternalIdFromDecodedRow(row: Record<string, unknown>, table: AnyTable): string {
  const value = row[table.getIdColumn().name];
  if (value instanceof FragnoId) {
    return value.externalId;
  }
  if (typeof value === "string") {
    return value;
  }
  throw new Error(`DynamoDB cursor row for ${table.name} is missing external ID.`);
}

function getIndexColumns(table: AnyTable, indexName: string) {
  if (indexName === "_primary") {
    return [table.getIdColumn()];
  }
  const index = table.indexes[indexName];
  if (!index) {
    throw new Error(`Index ${indexName} not found on table ${table.name}.`);
  }
  return index.columns;
}
