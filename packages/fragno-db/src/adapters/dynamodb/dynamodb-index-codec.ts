import { Buffer } from "node:buffer";

import type { AnyColumn } from "../../schema/create";
import { FragnoId, FragnoReference } from "../../schema/create";

export type DynamoDBIndexEncodingMode = "ordering" | "equality";

export interface DynamoDBIndexTupleSegment {
  column: AnyColumn;
  value: unknown;
}

const SEGMENT_SEPARATOR = "#";
const NON_UNIQUE_TIEBREAKER_MARKER = "~id~";
const MAX_BIGINT_DIGITS = 999999;

export function encodeDynamoDBIndexTuple(
  segments: readonly DynamoDBIndexTupleSegment[],
  options: { mode?: DynamoDBIndexEncodingMode } = {},
): string {
  const mode = options.mode ?? "ordering";
  return segments
    .map(({ column, value }) => encodeDynamoDBIndexValue(value, column, mode))
    .join(SEGMENT_SEPARATOR);
}

export function decodeDynamoDBIndexTuple(encoded: string): unknown[] {
  if (encoded.length === 0) {
    return [];
  }
  return encoded.split(SEGMENT_SEPARATOR).map(decodeDynamoDBIndexValue);
}

export function encodeDynamoDBIndexEntry(
  segments: readonly DynamoDBIndexTupleSegment[],
  externalId: string,
): string {
  return `${encodeDynamoDBIndexTuple(segments)}${SEGMENT_SEPARATOR}${NON_UNIQUE_TIEBREAKER_MARKER}${encodeStringSegment(externalId)}`;
}

export function decodeDynamoDBIndexEntry(encoded: string): {
  values: unknown[];
  externalId: string;
} {
  const marker = `${SEGMENT_SEPARATOR}${NON_UNIQUE_TIEBREAKER_MARKER}`;
  const markerIndex = encoded.lastIndexOf(marker);
  if (markerIndex === -1) {
    throw new Error("DynamoDB index entry is missing the non-unique external ID tiebreaker.");
  }
  return {
    values: decodeDynamoDBIndexTuple(encoded.slice(0, markerIndex)),
    externalId: decodeStringSegment(encoded.slice(markerIndex + marker.length)),
  };
}

export function encodeDynamoDBIndexValue(
  value: unknown,
  column: AnyColumn,
  mode: DynamoDBIndexEncodingMode = "ordering",
): string {
  const resolved = resolveIndexValue(value, column);
  if (resolved === null || resolved === undefined) {
    return "0";
  }

  if (column.type === "json") {
    if (mode === "ordering") {
      throw new TypeError(
        `JSON column ${column.tableName}.${column.name} cannot be used for ordered DynamoDB index ranges.`,
      );
    }
    return `8${encodeStringSegment(stableJson(resolved))}`;
  }

  if (column.type === "binary") {
    if (mode === "ordering") {
      throw new TypeError(
        `Binary column ${column.tableName}.${column.name} cannot be used for ordered DynamoDB index ranges.`,
      );
    }
    if (!(resolved instanceof Uint8Array)) {
      throw new TypeError(
        `Expected Uint8Array for binary column ${column.tableName}.${column.name}`,
      );
    }
    return `9${Buffer.from(resolved).toString("hex")}!`;
  }

  if (column.role === "internal-id" || column.role === "reference" || column.type === "bigint") {
    return `4${encodeBigintSegment(toBigint(resolved, column))}`;
  }

  switch (column.type) {
    case "bool":
      if (typeof resolved !== "boolean") {
        throw new TypeError(`Expected boolean for column ${column.tableName}.${column.name}`);
      }
      return resolved ? "11" : "10";
    case "integer":
    case "decimal":
      if (typeof resolved !== "number" || !Number.isFinite(resolved)) {
        throw new TypeError(`Expected finite number for column ${column.tableName}.${column.name}`);
      }
      return `3${encodeNumberSegment(resolved)}`;
    case "date":
    case "timestamp":
      if (!(resolved instanceof Date)) {
        throw new TypeError(`Expected Date for column ${column.tableName}.${column.name}`);
      }
      return `5${encodeStringSegment(resolved.toISOString())}`;
    case "string":
    case "text":
      if (typeof resolved !== "string") {
        throw new TypeError(`Expected string for column ${column.tableName}.${column.name}`);
      }
      return `6${encodeStringSegment(resolved)}`;
    default:
      if (column.type.startsWith("varchar(")) {
        if (typeof resolved !== "string") {
          throw new TypeError(`Expected string for column ${column.tableName}.${column.name}`);
        }
        return `6${encodeStringSegment(resolved)}`;
      }
      throw new TypeError(
        `Unsupported DynamoDB index column type ${String(column.type)} for ${column.tableName}.${column.name}`,
      );
  }
}

export function decodeDynamoDBIndexValue(encoded: string): unknown {
  const tag = encoded[0];
  const body = encoded.slice(1);
  switch (tag) {
    case "0":
      return null;
    case "1":
      if (body === "0") {
        return false;
      }
      if (body === "1") {
        return true;
      }
      throw new Error(`Invalid boolean index segment ${encoded}`);
    case "3":
      return decodeNumberSegment(body);
    case "4":
      return decodeBigintSegment(body);
    case "5":
      return new Date(decodeStringSegment(body));
    case "6":
      return decodeStringSegment(body);
    case "8":
      return JSON.parse(decodeStringSegment(body));
    case "9":
      if (!body.endsWith("!")) {
        throw new Error(`Invalid binary index segment ${encoded}`);
      }
      return Uint8Array.from(Buffer.from(body.slice(0, -1), "hex"));
    default:
      throw new Error(`Unknown DynamoDB index segment tag ${tag}`);
  }
}

export function assertDynamoDBIndexRangeSupported(column: AnyColumn): void {
  if (column.type === "json" || column.type === "binary") {
    throw new TypeError(
      `${column.type} column ${column.tableName}.${column.name} cannot be used for ordered DynamoDB index ranges.`,
    );
  }
}

function resolveIndexValue(value: unknown, column: AnyColumn): unknown {
  if (value instanceof FragnoReference) {
    return value.internalId;
  }
  if (value instanceof FragnoId) {
    return column.role === "external-id" ? value.externalId : value.databaseId;
  }
  return value;
}

function encodeNumberSegment(value: number): string {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  let bits = view.getBigUint64(0, false);
  if ((bits & (1n << 63n)) !== 0n) {
    bits = ~bits & ((1n << 64n) - 1n);
  } else {
    bits = bits ^ (1n << 63n);
  }
  return bits.toString(16).padStart(16, "0");
}

function decodeNumberSegment(encoded: string): number {
  let bits = BigInt(`0x${encoded}`);
  if ((bits & (1n << 63n)) !== 0n) {
    bits = bits ^ (1n << 63n);
  } else {
    bits = ~bits & ((1n << 64n) - 1n);
  }
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setBigUint64(0, bits, false);
  return view.getFloat64(0, false);
}

function toBigint(value: unknown, column: AnyColumn): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }
  throw new TypeError(
    `Expected bigint-compatible value for column ${column.tableName}.${column.name}`,
  );
}

function encodeBigintSegment(value: bigint): string {
  if (value === 0n) {
    return "1";
  }

  const magnitude = (value < 0n ? -value : value).toString();
  if (magnitude.length > MAX_BIGINT_DIGITS) {
    throw new RangeError(`Bigint index value has too many digits: ${magnitude.length}`);
  }

  if (value > 0n) {
    return `2${String(magnitude.length).padStart(6, "0")}${magnitude}`;
  }

  const complementedLength = String(MAX_BIGINT_DIGITS - magnitude.length).padStart(6, "0");
  const complementedDigits = magnitude.replace(/\d/g, (digit) => String(9 - Number(digit)));
  return `0${complementedLength}${complementedDigits}`;
}

function decodeBigintSegment(encoded: string): bigint {
  const signTag = encoded[0];
  if (signTag === "1") {
    return 0n;
  }
  const digits = encoded.slice(7);
  if (signTag === "2") {
    return BigInt(digits);
  }
  if (signTag === "0") {
    const restored = digits.replace(/\d/g, (digit) => String(9 - Number(digit)));
    return -BigInt(restored);
  }
  throw new Error(`Invalid bigint index segment ${encoded}`);
}

function encodeStringSegment(value: string): string {
  return `${Buffer.from(value, "utf8").toString("hex")}!`;
}

function decodeStringSegment(encoded: string): string {
  if (!encoded.endsWith("!")) {
    throw new Error(`Invalid string index segment ${encoded}`);
  }
  return Buffer.from(encoded.slice(0, -1), "hex").toString("utf8");
}

function stableJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  throw new TypeError("Unsupported JSON value for DynamoDB index equality encoding.");
}
