import { describe, expect, it, assert } from "vitest";

import { column, idColumn, schema } from "../../schema/create";
import { createInMemoryStore, ensureNamespaceStore } from "./store";

const testSchema = schema("test", (s) =>
  s
    .addTable("users", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .createIndex("name_idx", ["name"]),
    )
    .addTable("posts", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("userId", column("string"))
        .createIndex("user_idx", ["userId"], { unique: true }),
    ),
);

describe("in-memory store", () => {
  it("creates namespace tables with empty row maps and counters", () => {
    const store = createInMemoryStore();
    const namespaceStore = ensureNamespaceStore(store, "test", testSchema);

    assert(namespaceStore.tables.size === 2);
    assert(namespaceStore.tables.has("users"));
    assert(namespaceStore.tables.has("posts"));

    const usersTable = namespaceStore.tables.get("users");
    const postsTable = namespaceStore.tables.get("posts");

    assert(usersTable?.rows.size === 0);
    assert(postsTable?.rows.size === 0);
    assert(usersTable?.nextInternalId === 1n);
    assert(postsTable?.nextInternalId === 1n);
    assert(usersTable?.indexes.size === 2);
    assert(postsTable?.indexes.size === 2);
    assert(usersTable?.indexes.has("_primary"));
    assert(postsTable?.indexes.has("_primary"));

    const usersPrimary = usersTable?.indexes.get("_primary");
    const usersNameIdx = usersTable?.indexes.get("name_idx");
    const postsUserIdx = postsTable?.indexes.get("user_idx");

    expect(usersPrimary?.definition.columnNames).toEqual(["id"]);
    assert(usersPrimary?.definition.unique);
    expect(usersNameIdx?.definition.columnNames).toEqual(["name"]);
    assert(!usersNameIdx?.definition.unique);
    expect(postsUserIdx?.definition.columnNames).toEqual(["userId"]);
    assert(postsUserIdx?.definition.unique);
  });

  it("reuses existing namespace stores", () => {
    const store = createInMemoryStore();
    const first = ensureNamespaceStore(store, "test", testSchema);
    const usersTable = first.tables.get("users");
    if (usersTable) {
      usersTable.nextInternalId = 42n;
    }

    const second = ensureNamespaceStore(store, "test", testSchema);
    const usersTableAgain = second.tables.get("users");

    expect(second).toBe(first);
    assert(usersTableAgain?.nextInternalId === 42n);
  });
});
