import type { AnyColumn } from "@fragno-dev/db/schema";

export const normalizeValue = (value: unknown, column: AnyColumn): unknown => {
  if (value === null || value === undefined) {
    return value;
  }

  if (column.type === "date" || column.type === "timestamp") {
    if (value instanceof Date) {
      return value.getTime();
    }
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string") {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Invalid date value for ${column.name}: ${value}`);
      }
      return parsed.getTime();
    }
  }

  if (column.type === "bool") {
    if (typeof value === "boolean") {
      return value ? 1 : 0;
    }
    if (typeof value === "number") {
      return value ? 1 : 0;
    }
  }

  if (column.type === "bigint") {
    const bigintValue =
      typeof value === "bigint"
        ? value
        : typeof value === "number" || typeof value === "string"
          ? BigInt(value)
          : (() => {
              throw new Error(`Invalid bigint value for ${column.name}`);
            })();
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setBigInt64(0, bigintValue, false);
    return new Uint8Array(buffer);
  }

  if (column.type === "binary") {
    if (value instanceof Uint8Array) {
      return value;
    }
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
  }

  if (column.type === "json") {
    return JSON.stringify(value);
  }

  return value;
};
