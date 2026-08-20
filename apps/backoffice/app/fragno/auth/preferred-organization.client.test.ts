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
  test("migrates the legacy organization preference", () => {
    const storage = createStorage({ "fragno-auth.default-organization-id": "org-legacy" });

    assert(readPreferredOrganizationFromStorage(storage) === "org-legacy");
    assert(storage.values.get("fragno-backoffice-default-organization") === "org-legacy");
    assert(!storage.values.has("fragno-auth.default-organization-id"));
  });

  test("keeps the current preference and removes the legacy value", () => {
    const storage = createStorage({
      "fragno-auth.default-organization-id": "org-legacy",
      "fragno-backoffice-default-organization": "org-current",
    });

    assert(readPreferredOrganizationFromStorage(storage) === "org-current");
    assert(!storage.values.has("fragno-auth.default-organization-id"));
  });
});
