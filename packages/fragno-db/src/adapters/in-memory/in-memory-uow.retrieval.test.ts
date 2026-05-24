import { describe, expect, it } from "vitest";

import type { CompiledJoin } from "../../query/find-options";
import { UnitOfWork, type RetrievalOperation } from "../../query/unit-of-work/unit-of-work";
import { column, getTableRelations, idColumn, referenceColumn, schema } from "../../schema/create";
import {
  createInMemoryUowCompiler,
  createInMemoryUowExecutor,
  InMemoryUowDecoder,
} from "./in-memory-uow";
import { resolveInMemoryAdapterOptions } from "./options";
import { createInMemoryStore } from "./store";

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
        .addColumn("authorId", referenceColumn({ table: "users" })),
    )
    .addTable("memberships", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("userId", referenceColumn({ table: "users" }))
        .createIndex("idx_memberships_user", ["userId"]),
    ),
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

    const relation = getTableRelations(joinSchema.tables.posts)["author"];
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

    await expect(executor.executeRetrievalPhase([op])).rejects.toThrow(
      'In-memory adapter only supports orderByIndex; received orderBy on table "users".',
    );
  });
});
