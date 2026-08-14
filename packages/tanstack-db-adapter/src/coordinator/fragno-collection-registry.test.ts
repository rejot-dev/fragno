import { assert, describe, expect, it } from "vitest";

import { column, idColumn, schema } from "@fragno-dev/db/schema";
import Database from "better-sqlite3";

import { createNodeSQLitePersistence } from "@tanstack/node-db-sqlite-persistence";

import { FragnoCollectionRegistry } from "./fragno-collection-registry";
import { orderFragnoPersistenceWrites } from "./fragno-ordered-persistence";
import { FragnoOutboxSynchronizer } from "./fragno-outbox-synchronizer";

function createOutboxSynchronizer(): FragnoOutboxSynchronizer {
  return new FragnoOutboxSynchronizer({
    fetcher: {
      listOutbox: async () => [],
      openOutboxStream: async () => new ReadableStream(),
    },
    checkpointStore: {
      getCheckpoint: () => undefined,
      setCheckpoint() {},
    },
  });
}

const blogSchema = schema("blog", (builder) =>
  builder
    .addTable("users", (table) =>
      table.addColumn("id", idColumn()).addColumn("name", column("string")),
    )
    .addTable("posts", (table) =>
      table.addColumn("id", idColumn()).addColumn("title", column("string")),
    ),
);

describe("FragnoCollectionRegistry", () => {
  it("registers each collection once while the coordinator is idle", async () => {
    const database = new Database(":memory:");
    const persistence = orderFragnoPersistenceWrites(createNodeSQLitePersistence({ database }));
    const outbox = createOutboxSynchronizer();
    const registry = new FragnoCollectionRegistry({
      schemas: [blogSchema] as const,
      persistence,
      schemaVersion: 1,
      outbox,
    });

    const users = registry.registerCollection(blogSchema, "users", "idle", {
      rowUpdateMode: "full",
    });

    try {
      assert.equal(users.id, "fragno.outbox.table.v1:4:blog5:users");
      assert.equal(users.config.sync.rowUpdateMode, "full");
      assert.equal(registry.registerCollection(blogSchema, "users", "live"), users);
      expect(() => registry.registerCollection(blogSchema, "posts", "registering")).toThrow(
        "cannot be registered while the coordinator is registering",
      );
    } finally {
      await users.cleanup();
      outbox.dispose();
      await persistence.drain();
      database.close();
    }
  });

  it("rejects duplicate schema names", () => {
    const database = new Database(":memory:");
    const persistence = createNodeSQLitePersistence({ database });
    const duplicateSchema = schema("blog", (builder) =>
      builder.addTable("settings", (table) => table.addColumn("id", idColumn())),
    );
    const outbox = createOutboxSynchronizer();

    try {
      expect(
        () =>
          new FragnoCollectionRegistry({
            schemas: [blogSchema, duplicateSchema] as const,
            persistence,
            schemaVersion: 1,
            outbox,
          }),
      ).toThrow("Duplicate Fragno schema name blog");
    } finally {
      outbox.dispose();
      database.close();
    }
  });
});
