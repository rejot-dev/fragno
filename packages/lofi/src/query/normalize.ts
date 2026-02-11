import type { AnyColumn } from "@fragno-dev/db/schema";

const normalizeDateValue = (value: unknown, columnName: string): unknown => {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`Invalid date value for ${columnName}: ${value}`);
    }
    return parsed.getTime();
  }
  return value;
};

const normalizeBoolValue = (value: unknown): unknown => {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "number") {
    return value ? 1 : 0;
  }
  return value;
};

const normalizeBigintValue = (value: unknown, columnName: string): Uint8Array => {
  const bigintValue =
    typeof value === "bigint"
      ? value
      : typeof value === "number" || typeof value === "string"
        ? BigInt(value)
        : (() => {
            throw new Error(`Invalid bigint value for ${columnName}`);
          })();
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setBigInt64(0, bigintValue, false);
  return new Uint8Array(buffer);
};

const normalizeBinaryValue = (value: unknown): unknown => {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return value;
};

export const normalizeValue = (value: unknown, column: AnyColumn): unknown => {
  if (value === null || value === undefined) {
    return value;
  }

  switch (column.type) {
    case "date":
    case "timestamp":
      return normalizeDateValue(value, column.name);
    case "bool":
      return normalizeBoolValue(value);
    case "bigint":
      return normalizeBigintValue(value, column.name);
    case "binary":
      return normalizeBinaryValue(value);
    case "json":
      return JSON.stringify(value);
    default:
      return value;
  }
};
