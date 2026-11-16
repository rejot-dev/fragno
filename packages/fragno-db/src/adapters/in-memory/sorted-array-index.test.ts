import { describe, expect, it, assert } from "vitest";

import { UniqueConstraintError } from "./errors";
import { SortedArrayIndex } from "./sorted-array-index";

const compareValue = (left: unknown, right: unknown): number => {
  if (left === right) {
    return 0;
  }

  if (left === null || left === undefined) {
    return -1;
  }

  if (right === null || right === undefined) {
    return 1;
  }

  if (typeof left === "number" && typeof right === "number") {
    return left < right ? -1 : 1;
  }

  if (typeof left === "string" && typeof right === "string") {
    return left < right ? -1 : 1;
  }

  if (typeof left === "bigint" && typeof right === "bigint") {
    return left < right ? -1 : 1;
  }

  throw new Error("Unsupported comparison in test helper.");
};

const valuesFromScan = (
  index: SortedArrayIndex<string>,
  options?: { direction?: "asc" | "desc" },
) => index.scan(options).map((entry) => entry.value);

describe("sorted-array index", () => {
  it("keeps entries sorted by key and supports duplicates", () => {
    const index = new SortedArrayIndex<string>(compareValue);

    index.insert([2], "b");
    index.insert([1], "a");
    index.insert([2], "c");
    index.insert([3], "d");

    expect(valuesFromScan(index)).toEqual(["a", "b", "c", "d"]);
  });

  it("removes entries by key and value when duplicates exist", () => {
    const index = new SortedArrayIndex<string>(compareValue);

    index.insert([1], "a");
    index.insert([1], "b");
    index.insert([2], "c");

    assert(index.remove([1], "b"));
    expect(valuesFromScan(index)).toEqual(["a", "c"]);
    assert(!index.remove([3]));
  });

  it("updates entries by removing and re-inserting", () => {
    const index = new SortedArrayIndex<string>(compareValue);

    index.insert([1], "a");
    index.insert([2], "b");

    index.update([1], [3], "a");

    expect(valuesFromScan(index)).toEqual(["b", "a"]);
  });

  it("scans ranges with inclusive/exclusive bounds and direction", () => {
    const index = new SortedArrayIndex<string>(compareValue);

    index.insert([1], "a");
    index.insert([2], "b");
    index.insert([3], "c");
    index.insert([4], "d");

    const inclusive = index
      .scan({ start: [2], startInclusive: true, end: [3], endInclusive: true })
      .map((entry) => entry.value);
    expect(inclusive).toEqual(["b", "c"]);

    const exclusive = index
      .scan({ start: [2], startInclusive: false, end: [4], endInclusive: false })
      .map((entry) => entry.value);
    expect(exclusive).toEqual(["c"]);

    const descending = index
      .scan({ start: [2], end: [4], direction: "desc", endInclusive: true })
      .map((entry) => entry.value);
    expect(descending).toEqual(["d", "c", "b"]);
  });

  it("narrows scans to a key prefix within cursor bounds, in either direction", () => {
    const index = new SortedArrayIndex<string>(compareValue);

    index.insert(["a", 1], "a1");
    index.insert(["b", 1], "b1");
    index.insert(["b", 2], "b2");
    index.insert(["b", 3], "b3");
    index.insert(["c", 1], "c1");

    const scan = (options: Parameters<typeof index.scan>[0]) =>
      index.scan(options).map((entry) => entry.value);

    expect(scan({ prefix: ["b"] })).toEqual(["b1", "b2", "b3"]);
    expect(scan({ prefix: ["b"], direction: "desc" })).toEqual(["b3", "b2", "b1"]);
    expect(scan({ prefix: ["b", 2] })).toEqual(["b2"]);
    expect(scan({ prefix: ["bb"] })).toEqual([]);
    expect(scan({ prefix: ["b"], start: ["b", 1], startInclusive: false })).toEqual(["b2", "b3"]);
    expect(scan({ prefix: ["b"], end: ["b", 3], endInclusive: false, direction: "desc" })).toEqual([
      "b2",
      "b1",
    ]);
    expect(scan({ prefix: ["b"], start: ["a", 0], end: ["c", 9], endInclusive: true })).toEqual([
      "b1",
      "b2",
      "b3",
    ]);
  });

  it("respects scan limits", () => {
    const index = new SortedArrayIndex<string>(compareValue);

    index.insert([1], "a");
    index.insert([2], "b");
    index.insert([3], "c");

    expect(index.scan({ limit: 2 }).map((entry) => entry.value)).toEqual(["a", "b"]);
  });

  it("throws on duplicate keys when unique", () => {
    const index = new SortedArrayIndex<string>(compareValue, { unique: true });

    index.insert([1], "a");

    expect(() => index.insert([1], "b")).toThrow(UniqueConstraintError);
  });

  it("allows duplicate keys when unique enforcement is disabled", () => {
    const index = new SortedArrayIndex<string>(compareValue, { unique: true });

    index.insert([1], "a", { enforceUnique: false });
    index.insert([1], "b", { enforceUnique: false });

    expect(valuesFromScan(index)).toEqual(["a", "b"]);
  });
});
