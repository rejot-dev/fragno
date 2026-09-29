import { expect, test, assert } from "vitest";

import { CODEMODE_LIMITS } from "../codemode-limits";
import { decodeCodemodeFrame, encodeCodemodeFrame } from "./codemode-values";

test("codec preserves rich workflow values and treats user codec-shaped objects as data", () => {
  const value = {
    date: new Date("2026-09-29T00:00:00Z"),
    missing: undefined,
    bigint: 1n << 65n,
    negativeZero: -0,
    infinity: Infinity,
    nan: NaN,
    bytes: new Uint8Array([0, 128, 255]),
    buffer: new Uint8Array([42]).buffer,
    userData: { __codemode_binary_v1__: "ArrayBuffer", data: "not a codec value" },
    tuple: ["date", "not a date"],
  };
  expect(decodeCodemodeFrame(encodeCodemodeFrame(value))).toEqual(value);
});

test("decoded __proto__ remains an own data property without changing the result prototype", () => {
  const decoded = decodeCodemodeFrame('["object",[["__proto__",["object",[["polluted",true]]]]]]');
  expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  assert(Object.hasOwn(decoded as object, "__proto__"));
  expect({}).not.toHaveProperty("polluted");
});

test("rejects cycles, functions, malformed tags, duplicate keys, and invalid dates", () => {
  const cycle: unknown[] = [];
  cycle.push(cycle);
  expect(() => encodeCodemodeFrame(cycle)).toThrow("CODEMODE_CYCLIC_VALUE");
  expect(() => encodeCodemodeFrame(() => 1)).toThrow("CODEMODE_INVALID_VALUE");
  for (const wire of [
    '["date","wrong"]',
    '["bigint","1e9"]',
    '["function",1]',
    '["object",[["a",1],["a",2]]]',
    '["bytes","not base64"]',
  ]) {
    expect(() => decodeCodemodeFrame(wire)).toThrow("CODEMODE_INVALID_VALUE");
  }
});

test("enforces depth, collection, binary, and frame limits before application dispatch", () => {
  let nested: unknown = null;
  for (let i = 0; i <= CODEMODE_LIMITS.maxDepth; i++) {
    nested = [nested];
  }
  expect(() => encodeCodemodeFrame(nested)).toThrow("CODEMODE_VALUE_LIMIT_EXCEEDED");
  expect(() => encodeCodemodeFrame(Array(CODEMODE_LIMITS.maxEntries + 1).fill(null))).toThrow(
    "CODEMODE_VALUE_LIMIT_EXCEEDED",
  );
  expect(() => encodeCodemodeFrame(new Uint8Array(CODEMODE_LIMITS.maxBinaryBytes + 1))).toThrow(
    "CODEMODE_BINARY_LIMIT_EXCEEDED",
  );
  expect(() => decodeCodemodeFrame(" ".repeat(CODEMODE_LIMITS.maxFrameBytes + 1))).toThrow(
    "CODEMODE_FRAME_LIMIT_EXCEEDED",
  );
});
