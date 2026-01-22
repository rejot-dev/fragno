import { describe, expect, it } from "vitest";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import { ReferenceSubquery } from "../../query/value-encoding";
import { createInMemoryStore, ensureNamespaceStore } from "./store";
import { resolveReferenceSubqueries } from "./reference-resolution";

const testSchema = schema((s) =>
  s
    .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
    .addTable("posts", (t) => t.addColumn("id", idColumn()).addColumn("userId", referenceColumn()))
    .addReference("author", {
      type: "one",
      from: { table: "posts", column: "userId" },
      to: { table: "users", column: "id" },
    }),
);

describe("in-memory reference resolution", () => {
  it("resolves reference subqueries to internal IDs", () => {
    const store = createInMemoryStore();
    const namespaceStore = ensureNamespaceStore(store, "test", testSchema);
    const usersStore = namespaceStore.tables.get("users");
    if (!usersStore) {
      throw new Error("Missing users table store.");
    }

    usersStore.rows.set(1n, { id: "user-1", name: "Ada", _internalId: 1n, _version: 0 });

    const values = {
      userId: new ReferenceSubquery(testSchema.tables.users, "user-1"),
    };

    const resolved = resolveReferenceSubqueries(namespaceStore, values);

    expect(resolved).toEqual({ userId: 1n });
  });

  it("returns null when the referenced row is missing", () => {
    const store = createInMemoryStore();
    const namespaceStore = ensureNamespaceStore(store, "test", testSchema);

    const values = {
      userId: new ReferenceSubquery(testSchema.tables.users, "missing-user"),
    };

    const resolved = resolveReferenceSubqueries(namespaceStore, values);

    expect(resolved).toEqual({ userId: null });
  });
});
