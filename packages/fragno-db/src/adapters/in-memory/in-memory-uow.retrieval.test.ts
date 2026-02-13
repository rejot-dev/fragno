import { describe, expect, it } from "vitest";
import { column, idColumn, referenceColumn, schema, type AnySchema } from "../../schema/create";
import {
  UnitOfWork,
  type RetrievalOperation,
  type UnitOfWorkConfig,
} from "../../query/unit-of-work/unit-of-work";
import { createInMemoryStore } from "./store";
import {
  createInMemoryUowCompiler,
  createInMemoryUowExecutor,
  InMemoryUowDecoder,
} from "./in-memory-uow";
import { resolveInMemoryAdapterOptions } from "./options";
import type { CompiledJoin } from "../../query/orm/orm";

const joinSchema = schema("join", (s) =>
  s
    .addTable("users", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("email", column("string"))
        .createIndex("idx_users_name", ["name"]),
    )
    .addTable("posts", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("title", column("string"))
        .addColumn("authorId", referenceColumn()),
    )
    .addReference("author", {
      type: "one",
      from: { table: "posts", column: "authorId" },
      to: { table: "users", column: "id" },
    }),
);

const createHarness = () => {
  const store = createInMemoryStore();
  const options = resolveInMemoryAdapterOptions({ idSeed: "seed" });
  const compiler = createInMemoryUowCompiler();
  const executor = createInMemoryUowExecutor(store, options);
  const decoder = new InMemoryUowDecoder();

  return {
    createUow: () => new UnitOfWork(compiler, executor, decoder).forSchema(joinSchema),
    executor,
  };
};

const createJoinShardHarness = () => {
  const store = createInMemoryStore();
  const options = resolveInMemoryAdapterOptions({ idSeed: "seed" });
  const compiler = createInMemoryUowCompiler();
  const executor = createInMemoryUowExecutor(store, options);
  const decoder = new InMemoryUowDecoder();

  return {
    createUow: (config?: UnitOfWorkConfig) =>
      new UnitOfWork(compiler, executor, decoder, undefined, config).forSchema(joinSchema),
  };
};

describe("in-memory uow retrieval", () => {
  it("throws when joins use orderBy instead of orderByIndex", async () => {
    const { createUow, executor } = createHarness();

    const createData = createUow();
    createData.create("users", {
      id: "user-1",
      name: "Ada",
      email: "ada@example.com",
    });
    createData.create("posts", {
      id: "post-1",
      title: "Hello",
      authorId: "user-1",
    });
    await createData.executeMutations();

    const relation = joinSchema.tables.posts.relations.author;
    const join: CompiledJoin = {
      relation,
      options: {
        select: true,
        where: undefined,
        orderBy: [[joinSchema.tables.users.columns.email, "asc"]],
        join: undefined,
        limit: undefined,
      },
    };

    const op = {
      type: "find",
      schema: joinSchema,
      table: joinSchema.tables.posts,
      indexName: "_primary",
      options: {
        useIndex: "_primary",
        select: true,
        where: undefined,
        orderByIndex: undefined,
        after: undefined,
        before: undefined,
        pageSize: undefined,
        joins: [join],
      },
    } satisfies RetrievalOperation<typeof joinSchema>;

    const opForExecutor = op as unknown as RetrievalOperation<AnySchema>;

    await expect(executor.executeRetrievalPhase([opForExecutor])).rejects.toThrow(
      'In-memory adapter only supports orderByIndex; received orderBy on table "users".',
    );
  });

  it("filters joined table rows by shard in row mode", async () => {
    const { createUow } = createJoinShardHarness();
    const shardingStrategy = { mode: "row" } as const;

    const createShardB = createUow({
      shardingStrategy,
      getShard: () => "shard-b",
    });
    createShardB.create("users", {
      id: "user-b",
      name: "Bea",
      email: "bea@example.com",
    });
    await createShardB.executeMutations();

    const createShardA = createUow({
      shardingStrategy,
      getShard: () => "shard-a",
    });
    createShardA.create("users", {
      id: "user-a",
      name: "Ada",
      email: "ada@example.com",
    });
    createShardA.create("posts", {
      id: "post-a",
      title: "Post A",
      authorId: "user-a",
    });
    createShardA.create("posts", {
      id: "post-cross",
      title: "Cross",
      authorId: "user-b",
    });
    await createShardA.executeMutations();

    const findShardA = createUow({
      shardingStrategy,
      getShard: () => "shard-a",
    });
    findShardA.find("posts", (b) =>
      b.whereIndex("primary").join((jb) => jb.author((builder) => builder.select(["name"]))),
    );
    const results = (await findShardA.executeRetrieve()) as unknown[];
    const rows = results[0] as Array<{ title: string; author?: { name: string } }>;

    const sameShard = rows.find((row) => row.title === "Post A");
    const crossShard = rows.find((row) => row.title === "Cross");

    expect(sameShard?.author?.name).toBe("Ada");
    expect(crossShard?.author).toBeUndefined();
  });
});
