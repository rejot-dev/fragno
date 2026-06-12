import { describe, test, assert } from "vitest";

import { atom, map } from "nanostores";

import { isReadableAtom } from "./nanostores";

describe("nanostores", () => {
  test("isReadableAtom should return true for a readable atom", () => {
    const store = atom(0);
    assert(isReadableAtom(store));
  });

  test("isReadableAtom should return false for a non-readable atom", () => {
    const store = { get: () => 0 };
    assert(!isReadableAtom(store));
  });

  test("isReadableAtom should return false for a non-object", () => {
    assert(!isReadableAtom(0));
  });

  test("isReadableAtom should return false for a null value", () => {
    assert(!isReadableAtom(null));
  });

  test("isReadableAtom should return true for map", () => {
    const store = map({ a: 1 });
    assert(isReadableAtom(store));
  });
});
