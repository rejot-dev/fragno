import { describe, it, expect } from "vitest";
import { schema, idColumn, column, referenceColumn, FragnoId } from "../schema/create";
import {
  createUnitOfWork,
  type UOWCompiler,
  type UOWDecoder,
  type UOWExecutor,
} from "../query/unit-of-work/unit-of-work";
import {
  collectReadKeys,
  collectReadScopes,
  collectWriteKeys,
  stripReadTrackingResults,
} from "./read-tracking";

type AnyExecutor = UOWExecutor<unknown, unknown>;

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
        .addColumn("author_id", referenceColumn())
        .addColumn("title", column("string")),
    )
    .addTable("comments", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("post_id", referenceColumn())
        .addColumn("commenter_id", referenceColumn())
        .addColumn("text", column("string")),
    )
    .addReference("post", {
      type: "one",
      from: { table: "comments", column: "post_id" },
      to: { table: "posts", column: "id" },
    })
    .addReference("author", {
      type: "one",
      from: { table: "posts", column: "author_id" },
      to: { table: "users", column: "id" },
    })
    .addReference("commenter", {
      type: "one",
      from: { table: "comments", column: "commenter_id" },
      to: { table: "users", column: "id" },
    }),
);

const createMockCompiler = (): UOWCompiler<unknown> => ({
  compileRetrievalOperation: () => null,
  compileMutationOperation: () => null,
});

const createMockDecoder = (): UOWDecoder => ({
  decode(rawResults) {
    return rawResults;
  },
});

const createMockExecutor = (): AnyExecutor => ({
  executeRetrievalPhase: async () => [],
  executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
});

describe("read tracking", () => {
  it("collects read scopes, keys, and strips extended ids", () => {
    const compiler = createMockCompiler();
    const executor = createMockExecutor();
    const decoder = createMockDecoder();
    const schemaNamespaceMap = new WeakMap();
    schemaNamespaceMap.set(testSchema, "tenant");

    const baseUow = createUnitOfWork(compiler, executor, decoder, schemaNamespaceMap);
    baseUow.enableReadTracking();

    baseUow.forSchema(testSchema).find("comments", (b) =>
      b
        .whereIndex("primary")
        .select(["text"])
        .join((jb) =>
          jb["post"]((pb) =>
            pb.select(["title"]).join((jb2) => jb2["author"]((ab) => ab.select(["name"]))),
          )["commenter"]((cb) => cb.select(["name"])),
        ),
    );

    const operations = baseUow.getRetrievalOperations();
    const commentId = FragnoId.fromExternal("c1", 1);
    const postId = FragnoId.fromExternal("p1", 1);
    const authorId = FragnoId.fromExternal("a1", 1);
    const commenterId = FragnoId.fromExternal("u2", 1);

    const results = [
      [
        {
          id: commentId,
          text: "hello",
          post: {
            id: postId,
            title: "post",
            author: {
              id: authorId,
              name: "author",
            },
          },
          commenter: {
            id: commenterId,
            name: "commenter",
          },
        },
      ],
    ];

    const scopes = collectReadScopes(operations);
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({
      schema: "tenant",
      table: testSchema.tables.comments,
      indexName: "_primary",
    });

    const keys = collectReadKeys(operations, results);
    expect(keys).toEqual(
      expect.arrayContaining([
        { schema: "tenant", table: "comments", externalId: "c1" },
        { schema: "tenant", table: "posts", externalId: "p1" },
        { schema: "tenant", table: "users", externalId: "a1" },
        { schema: "tenant", table: "users", externalId: "u2" },
      ]),
    );

    stripReadTrackingResults(operations, results);

    const [comment] = results[0] as Array<Record<string, unknown>>;
    expect(comment["id"]).toBeUndefined();
    expect((comment["post"] as Record<string, unknown>)["id"]).toBeUndefined();
    expect((comment["commenter"] as Record<string, unknown>)["id"]).toBeUndefined();
    expect(
      ((comment["post"] as Record<string, unknown>)["author"] as Record<string, unknown>)["id"],
    ).toBeUndefined();
  });

  it("collects write keys from mutation operations", () => {
    const compiler = createMockCompiler();
    const executor = createMockExecutor();
    const decoder = createMockDecoder();
    const schemaNamespaceMap = new WeakMap();
    schemaNamespaceMap.set(testSchema, "tenant");

    const baseUow = createUnitOfWork(compiler, executor, decoder, schemaNamespaceMap);
    const uow = baseUow.forSchema(testSchema);

    const createdId = uow.create("users", { name: "test" });
    uow.update("users", createdId, (b) => b.set({ name: "next" }));
    uow.delete("users", createdId);

    const keys = collectWriteKeys(baseUow.getMutationOperations());
    expect(keys).toEqual(
      expect.arrayContaining([expect.objectContaining({ table: "users", schema: "tenant" })]),
    );
  });
});
