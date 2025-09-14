import type { ReadableAtom } from "nanostores";

type MaybeAtom<T> = T | ReadableAtom<T>;

/**
 * Normalizes a value that could be a plain value, an Atom, or a Vue Ref to a plain value.
 */
export function unwrapAtom<T>(value: MaybeAtom<T>): T {
  // Check if it's an Atom (has .get method)
  if (value && typeof value === "object" && "get" in value && typeof value.get === "function") {
    return value.get();
  }

  return value as T;
}

/**
 * Normalizes an object where values can be plain values, Atoms, or Vue Refs.
 * Returns a new object with all values normalized to plain values.
 */
export function unwrapObject<T>(
  params: Record<string, MaybeAtom<T>> | undefined,
): Record<string, T> | undefined {
  if (!params) {
    return undefined;
  }

  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, unwrapAtom(value)]));
}

export function isReadableAtom(value: unknown): value is ReadableAtom<unknown> {
  if (!value) {
    return false;
  }

  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!("get" in value) || typeof value.get !== "function") {
    return false;
  }

  if (!("lc" in value) || typeof value.lc !== "number") {
    return false;
  }

  if (!("notify" in value) || typeof value.notify !== "function") {
    return false;
  }

  if (!("off" in value) || typeof value.off !== "function") {
    return false;
  }

  if (!("subscribe" in value) || typeof value.subscribe !== "function") {
    return false;
  }

  if (!("value" in value)) {
    return false;
  }

  return true;
}
