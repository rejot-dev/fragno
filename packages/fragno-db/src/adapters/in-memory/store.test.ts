import { describe, expect, it } from "vitest";
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

    expect(namespaceStore.tables.size).toBe(2);
    expect(namespaceStore.tables.has("users")).toBe(true);
    expect(namespaceStore.tables.has("posts")).toBe(true);

    const usersTable = namespaceStore.tables.get("users");
    const postsTable = namespaceStore.tables.get("posts");

    expect(usersTable?.rows.size).toBe(0);
    expect(postsTable?.rows.size).toBe(0);
    expect(usersTable?.nextInternalId).toBe(1n);
    expect(postsTable?.nextInternalId).toBe(1n);
    expect(usersTable?.indexes.size).toBe(3);
    expect(postsTable?.indexes.size).toBe(3);
    expect(usersTable?.indexes.has("_primary")).toBe(true);
    expect(postsTable?.indexes.has("_primary")).toBe(true);

    const usersPrimary = usersTable?.indexes.get("_primary");
    const usersNameIdx = usersTable?.indexes.get("name_idx");
    const postsUserIdx = postsTable?.indexes.get("user_idx");
    const usersShardIdx = usersTable?.indexes.get("idx_users_shard");
    const postsShardIdx = postsTable?.indexes.get("idx_posts_shard");

    expect(usersPrimary?.definition.columnNames).toEqual(["id"]);
    expect(usersPrimary?.definition.unique).toBe(true);
    expect(usersNameIdx?.definition.columnNames).toEqual(["name"]);
    expect(usersNameIdx?.definition.unique).toBe(false);
    expect(postsUserIdx?.definition.columnNames).toEqual(["userId"]);
    expect(postsUserIdx?.definition.unique).toBe(true);
    expect(usersShardIdx?.definition.columnNames).toEqual(["_shard"]);
    expect(usersShardIdx?.definition.unique).toBe(false);
    expect(postsShardIdx?.definition.columnNames).toEqual(["_shard"]);
    expect(postsShardIdx?.definition.unique).toBe(false);
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
    expect(usersTableAgain?.nextInternalId).toBe(42n);
  });
});
