import { beforeEach, describe, expect, it } from "vitest";
import {
  IDBCursor,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRequest,
  IDBTransaction,
} from "fake-indexeddb";
import {
  column,
  idColumn,
  referenceColumn,
  schema,
  FragnoReference,
  FragnoId,
} from "@fragno-dev/db/schema";
import { createLocalHandlerTx } from "./local-handler-tx";
import { IndexedDbAdapter } from "../indexeddb/adapter";

const appSchema = schema("app", (s) => {
  return s
    .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("email", column("string")))
    .addTable("posts", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("authorId", referenceColumn())
        .addColumn("title", column("string"))
        .createIndex("idx_author", ["authorId"]),
    )
    .addReference("author", {
      type: "one",
      from: { table: "posts", column: "authorId" },
      to: { table: "users", column: "id" },
    });
});

const createDbName = () => `lofi-local-${Math.random().toString(16).slice(2)}`;

describe("local handler tx", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    globalThis.IDBCursor = IDBCursor;
    globalThis.IDBDatabase = IDBDatabase;
    globalThis.IDBIndex = IDBIndex;
    globalThis.IDBKeyRange = IDBKeyRange;
    globalThis.IDBObjectStore = IDBObjectStore;
    globalThis.IDBOpenDBRequest = IDBOpenDBRequest;
    globalThis.IDBRequest = IDBRequest;
    globalThis.IDBTransaction = IDBTransaction;
  });

  it("applies handlerTx mutations locally, including references", async () => {
    const adapter = new IndexedDbAdapter({
      dbName: createDbName(),
      endpointName: "app",
      schemas: [{ schema: appSchema }],
    });

    const handlerTx = createLocalHandlerTx({
      adapter,
      schemas: [appSchema],
    });

    await handlerTx()
      .mutate(({ forSchema }) => {
        const userId = forSchema(appSchema).create("users", { email: "alpha@example.com" });
        forSchema(appSchema).create("posts", {
          authorId: userId,
          title: "Hello",
        });
      })
      .execute();

    const query = adapter.createQueryEngine(appSchema);
    const posts = await query.find("posts", (b) =>
      b.whereIndex("idx_author").join((j) => j.author()),
    );

    expect(posts).toHaveLength(1);
    expect(posts[0].author?.email).toBe("alpha@example.com");
  });

  it("supports replaying mutations using reference values from reads", async () => {
    const adapter = new IndexedDbAdapter({
      dbName: createDbName(),
      endpointName: "app",
      schemas: [{ schema: appSchema }],
    });

    const handlerTx = createLocalHandlerTx({
      adapter,
      schemas: [appSchema],
    });

    await handlerTx()
      .mutate(({ forSchema }) => {
        const userId = forSchema(appSchema).create("users", { email: "beta@example.com" });
        forSchema(appSchema).create("posts", {
          authorId: userId,
          title: "First",
        });
      })
      .execute();

    await handlerTx()
      .retrieve(({ forSchema }) =>
        forSchema(appSchema).findFirst("posts", (b) => b.whereIndex("idx_author")),
      )
      .mutate(({ forSchema, retrieveResult }) => {
        const [post] = retrieveResult as Array<{
          authorId: string | bigint | FragnoId | FragnoReference;
        } | null>;
        if (!post) {
          return;
        }
        forSchema(appSchema).create("posts", {
          authorId: post.authorId,
          title: "Second",
        });
      })
      .execute();

    const query = adapter.createQueryEngine(appSchema);
    const posts = await query.find("posts", (b) => b.whereIndex("idx_author"));
    expect(posts.map((post) => post.title).sort()).toEqual(["First", "Second"]);
  });
});
