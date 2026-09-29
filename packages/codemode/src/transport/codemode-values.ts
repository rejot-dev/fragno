import { CODEMODE_LIMITS } from "../codemode-limits";

type WireValue = null | boolean | string | number | [string, ...unknown[]];
const encoder = new TextEncoder();

function failValue(): never {
  throw new Error("CODEMODE_INVALID_VALUE");
}

function createValueBudget() {
  let values = 0;
  return function check(depth: number, entries: number) {
    if (
      ++values > CODEMODE_LIMITS.maxValues ||
      depth > CODEMODE_LIMITS.maxDepth ||
      entries > CODEMODE_LIMITS.maxEntries
    ) {
      throw new Error("CODEMODE_VALUE_LIMIT_EXCEEDED");
    }
  };
}

/** Encodes containers as tagged tuples so user objects cannot collide with codec tags. */
export function encodeCodemodeFrame(value: unknown): string {
  const check = createValueBudget();
  const ancestors = new Set<object>();
  function encode(value: unknown, depth: number): WireValue {
    check(depth, 0);
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) && !Object.is(value, -0)
        ? value
        : ["number", Object.is(value, -0) ? "-0" : String(value)];
    }
    if (value === undefined) {
      return ["undefined"];
    }
    if (typeof value === "bigint") {
      return ["bigint", String(value)];
    }
    if (typeof value !== "object") {
      return failValue();
    }
    if (value instanceof Date) {
      return ["date", value.toISOString()];
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const bytes =
        value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      if (bytes.byteLength > CODEMODE_LIMITS.maxBinaryBytes) {
        throw new Error("CODEMODE_BINARY_LIMIT_EXCEEDED");
      }
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return [value instanceof ArrayBuffer ? "buffer" : "bytes", btoa(binary)];
    }
    if (ancestors.has(value)) {
      throw new Error("CODEMODE_CYCLIC_VALUE");
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        check(depth, value.length);
        return ["array", Array.from(value, (entry) => encode(entry, depth + 1))];
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        return failValue();
      }
      const entries = Object.entries(value);
      check(depth, entries.length);
      return ["object", entries.map(([key, entry]) => [key, encode(entry, depth + 1)])];
    } finally {
      ancestors.delete(value);
    }
  }
  const text = JSON.stringify(encode(value, 0));
  if (encoder.encode(text).byteLength > CODEMODE_LIMITS.maxFrameBytes) {
    throw new Error("CODEMODE_FRAME_LIMIT_EXCEEDED");
  }
  return text;
}

/** Validates wire structure and budgets before constructing any application values. */
export function decodeCodemodeFrame(text: string): unknown {
  if (encoder.encode(text).byteLength > CODEMODE_LIMITS.maxFrameBytes) {
    throw new Error("CODEMODE_FRAME_LIMIT_EXCEEDED");
  }
  const check = createValueBudget();
  function decode(value: unknown, depth: number): unknown {
    check(depth, 0);
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (!Array.isArray(value)) {
      return failValue();
    }
    const [tag, payload] = value;
    if (tag === "undefined" && value.length === 1) {
      return undefined;
    }
    if (value.length !== 2) {
      return failValue();
    }
    if (tag === "array" && Array.isArray(payload)) {
      check(depth, payload.length);
      return payload.map((entry) => decode(entry, depth + 1));
    }
    if (tag === "object" && Array.isArray(payload)) {
      check(depth, payload.length);
      const object: Record<string, unknown> = {};
      for (const entry of payload) {
        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== "string" ||
          Object.hasOwn(object, entry[0])
        ) {
          return failValue();
        }
        Object.defineProperty(object, entry[0], {
          value: decode(entry[1], depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return object;
    }
    if (typeof payload !== "string") {
      return failValue();
    }
    switch (tag) {
      case "number":
        switch (payload) {
          case "-0":
            return -0;
          case "NaN":
            return NaN;
          case "Infinity":
            return Infinity;
          case "-Infinity":
            return -Infinity;
          default:
            return failValue();
        }
      case "bigint":
        if (!/^-?(0|[1-9][0-9]*)$/.test(payload) || payload.length > 4096) {
          return failValue();
        }
        return BigInt(payload);
      case "date": {
        const date = new Date(payload);
        if (!Number.isFinite(date.getTime()) || date.toISOString() !== payload) {
          return failValue();
        }
        return date;
      }
      case "buffer":
      case "bytes": {
        if (
          payload.length > Math.ceil(CODEMODE_LIMITS.maxBinaryBytes / 3) * 4 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)
        ) {
          return failValue();
        }
        const binary = atob(payload);
        if (binary.length > CODEMODE_LIMITS.maxBinaryBytes) {
          throw new Error("CODEMODE_BINARY_LIMIT_EXCEEDED");
        }
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return tag === "buffer" ? bytes.buffer : bytes;
      }
      default:
        return failValue();
    }
  }
  return decode(JSON.parse(text), 0);
}
