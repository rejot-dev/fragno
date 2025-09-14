import { describe, test, expect } from "vitest";
import { isReadableAtom } from "./nanostores";
import { atom, map } from "nanostores";

describe("nanostores", () => {
  test("isReadableAtom should return true for a readable atom", () => {
    const store = atom(0);
    expect(isReadableAtom(store)).toBe(true);
  });

  test("isReadableAtom should return false for a non-readable atom", () => {
    const store = { get: () => 0 };
    expect(isReadableAtom(store)).toBe(false);
  });

  test("isReadableAtom should return false for a non-object", () => {
    expect(isReadableAtom(0)).toBe(false);
  });

  test("isReadableAtom should return false for a null value", () => {
    expect(isReadableAtom(null)).toBe(false);
  });

  test("isReadableAtom should return true for map", () => {
    const store = map({ a: 1 });
    expect(isReadableAtom(store)).toBe(true);
  });
});
