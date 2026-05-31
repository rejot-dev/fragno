import { Buffer } from "node:buffer";

import type { AnyColumn, AnyTable } from "../../schema/create";
import { DynamoDBItemSizeError } from "./errors";

export type DynamoDBAttributeValue =
  | string
  | number
  | boolean
  | null
  | Uint8Array
  | DynamoDBMap
  | DynamoDBList;
export type DynamoDBMap = { [key: string]: DynamoDBAttributeValue };
export type DynamoDBList = DynamoDBAttributeValue[];

export interface BaseRowItem {
  pk: string;
  id: string;
  _internalId: string;
  _version: number;
  [physicalColumn: string]: DynamoDBAttributeValue | undefined;
}

export function encodeDynamoDBValue(
  value: unknown,
  column: AnyColumn,
): DynamoDBAttributeValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }

  if (column.role === "internal-id" || column.role === "reference" || column.type === "bigint") {
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (typeof value === "number" && Number.isInteger(value)) {
      return String(value);
    }
    if (typeof value === "string" && /^-?\d+$/.test(value)) {
      return value;
    }
    throw new TypeError(
      `Expected bigint-compatible value for column ${column.tableName}.${column.name}`,
    );
  }

  switch (column.type) {
    case "string":
    case "text":
      return assertType(value, "string", column);
    case "integer":
    case "decimal":
      return assertType(value, "number", column);

    case "bool":
      return assertType(value, "boolean", column);
    case "json":
      return encodeDynamoDBJson(value);
    case "binary":
      return encodeDynamoDBBinary(value, column);
    case "date":
    case "timestamp":
      if (!(value instanceof Date)) {
        throw new TypeError(`Expected Date for column ${column.tableName}.${column.name}`);
      }
      return value.toISOString();
    default:
      if (column.type.startsWith("varchar(")) {
        return assertType(value, "string", column);
      }
      throw new TypeError(
        `Unsupported DynamoDB column type ${String(column.type)} for ${column.tableName}.${column.name}`,
      );
  }
}

export function decodeDynamoDBValue(value: unknown, column: AnyColumn): unknown {
  if (value === undefined || value === null) {
    return value;
  }

  if (column.role === "internal-id" || column.role === "reference" || column.type === "bigint") {
    if (typeof value !== "string") {
      throw new TypeError(
        `Expected decimal string bigint for column ${column.tableName}.${column.name}`,
      );
    }
    return BigInt(value);
  }

  switch (column.type) {
    case "string":
    case "text":
      return assertType(value, "string", column);
    case "integer":
    case "decimal":
      return assertType(value, "number", column);

    case "bool":
      return assertType(value, "boolean", column);
    case "json":
      return value;
    case "binary":
      return encodeDynamoDBBinary(value, column);
    case "date":
    case "timestamp":
      return new Date(assertType(value, "string", column));
    default:
      if (column.type.startsWith("varchar(")) {
        return assertType(value, "string", column);
      }
      throw new TypeError(
        `Unsupported DynamoDB column type ${String(column.type)} for ${column.tableName}.${column.name}`,
      );
  }
}

export function encodeDynamoDBItemAttributes(
  values: Record<string, unknown>,
  table: AnyTable,
): Record<string, DynamoDBAttributeValue> {
  const output: Record<string, DynamoDBAttributeValue> = {};
  for (const [columnName, value] of Object.entries(values)) {
    const column = table.columns[columnName];
    if (!column) {
      continue;
    }
    const encoded = encodeDynamoDBValue(value, column);
    if (encoded !== undefined) {
      output[columnName] = encoded;
    }
  }
  return output;
}

export function decodeDynamoDBItemAttributes(
  item: Record<string, unknown>,
  table: AnyTable,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [columnName, column] of Object.entries(table.columns)) {
    if (!Object.prototype.hasOwnProperty.call(item, columnName)) {
      continue;
    }
    output[columnName] = decodeDynamoDBValue(item[columnName], column);
  }
  return output;
}

export function estimateDynamoDBItemSizeBytes(item: unknown): number {
  return Buffer.byteLength(stableStringifyForSize(item), "utf8");
}

export function assertDynamoDBItemSize(item: unknown, maxBytes = 400 * 1024): void {
  const estimated = estimateDynamoDBItemSizeBytes(item);
  if (estimated > maxBytes) {
    throw new DynamoDBItemSizeError(
      `DynamoDB item is too large: estimated ${estimated} bytes exceeds ${maxBytes} bytes.`,
    );
  }
}

function assertType<T extends "string" | "number" | "boolean">(
  value: unknown,
  type: T,
  column: AnyColumn,
): T extends "string" ? string : T extends "number" ? number : boolean {
  if (typeof value !== type) {
    throw new TypeError(`Expected ${type} for column ${column.tableName}.${column.name}`);
  }
  return value as T extends "string" ? string : T extends "number" ? number : boolean;
}

function encodeDynamoDBBinary(value: unknown, column: AnyColumn): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  throw new TypeError(`Expected Uint8Array for column ${column.tableName}.${column.name}`);
}

function encodeDynamoDBJson(value: unknown): DynamoDBAttributeValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (
    value instanceof Uint8Array ||
    value instanceof Date ||
    typeof value === "bigint" ||
    typeof value === "undefined"
  ) {
    throw new TypeError(
      "DynamoDB JSON values must be DocumentClient-compatible JSON scalars, arrays, or maps.",
    );
  }
  if (Array.isArray(value)) {
    return value.map(encodeDynamoDBJson);
  }
  if (typeof value === "object") {
    const output: DynamoDBMap = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child !== undefined) {
        output[key] = encodeDynamoDBJson(child);
      }
    }
    return output;
  }
  throw new TypeError("Unsupported DynamoDB JSON value.");
}

function stableStringifyForSize(value: unknown): string {
  return (
    JSON.stringify(value, (_key, child) => {
      if (typeof child === "bigint") {
        return child.toString();
      }
      if (child instanceof Uint8Array) {
        return Buffer.from(child).toString("base64");
      }
      return child;
    }) ?? ""
  );
}
