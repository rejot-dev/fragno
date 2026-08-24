import { describe, test, assert } from "vitest";

import { readPreferredOrganizationFromStorage } from "./preferred-organization.client";

const createStorage = (initial: Record<string, string>) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  };
};

describe("Backoffice organization preference", () => {
  test("reads the current organization preference", () => {
    const storage = createStorage({
      "fragno-backoffice-default-organization": "org-current",
    });

    assert(readPreferredOrganizationFromStorage(storage) === "org-current");
  });

  test("removes blank organization preferences", () => {
    const storage = createStorage({
      "fragno-backoffice-default-organization": "   ",
    });

    assert(readPreferredOrganizationFromStorage(storage) === null);
    assert(!storage.values.has("fragno-backoffice-default-organization"));
  });
});
