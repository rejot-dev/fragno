import { describe, expect, it } from "vitest";

import type { CompiledJoin } from "../../query/find-options";
import { UnitOfWork, type RetrievalOperation } from "../../query/unit-of-work/unit-of-work";
import {
  column,
  ExplicitRelationInit,
  idColumn,
  referenceColumn,
  schema,
  type AnySchema,
} from "../../schema/create";
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
        .addColumn("authorId", referenceColumn()),
    )
    .addTable("memberships", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("userId", referenceColumn())
        .createIndex("idx_memberships_user", ["userId"]),
    )
    .addReference("author", {
      type: "one",
      from: { table: "posts", column: "authorId" },
      to: { table: "users", column: "id" },
    })
    .addReference("membershipUser", {
      type: "one",
      from: { table: "memberships", column: "userId" },
      to: { table: "users", column: "id" },
    })
    .addReference("memberships", {
      type: "many",
      from: { table: "users", column: "id" },
      to: { table: "memberships", column: "userId" },
      foreignKey: false,
    }),
);

const externalJoinSchema = schema("external-join", (s) =>
  s
    .addTable("left", (t) => t.addColumn("id", idColumn()).addColumn("label", column("string")))
    .addTable("right", (t) => t.addColumn("id", idColumn()).addColumn("label", column("string"))),
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

const createExternalJoinHarness = () => {
  const store = createInMemoryStore();
  const options = resolveInMemoryAdapterOptions({ idSeed: "seed" });
  const compiler = createInMemoryUowCompiler();
  const executor = createInMemoryUowExecutor(store, options);
  const decoder = new InMemoryUowDecoder();

  return {
    createUow: () => new UnitOfWork(compiler, executor, decoder).forSchema(externalJoinSchema),
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

  it("joins join-only relations using left-side id coercion", async () => {
    const { createUow } = createHarness();

    const createData = createUow();
    createData.create("users", {
      id: "user-1",
      name: "Ada",
      email: "ada@example.com",
    });
    createData.create("memberships", {
      id: "membership-1",
      userId: "user-1",
    });
    await createData.executeMutations();

    const query = createUow();
    query.findNew("users", (b) =>
      b
        .whereIndex("primary", (eb) => eb("id", "=", "user-1"))
        .joinMany("memberships", "memberships", (mb) =>
          mb
            .onIndex("idx_memberships_user", (eb) => eb("userId", "=", eb.parent("id")))
            .select(["id"]),
        ),
    );

    const [users] = (await query.executeRetrieve()) as Array<
      Array<{ memberships?: Array<{ id: { externalId: string } }> }>
    >;

    expect(users).toHaveLength(1);
    expect(users[0].memberships).toMatchObject([
      {
        id: expect.objectContaining({ externalId: "membership-1" }),
      },
    ]);
  });

  it("joins external-id relations without coercing both sides to internal ids", async () => {
    const { createUow } = createExternalJoinHarness();

    const relationInit = new ExplicitRelationInit(
      "one",
      externalJoinSchema.tables.right,
      externalJoinSchema.tables.left,
      { foreignKey: false },
    );
    relationInit.on.push(["id", "id"]);
    const relation = relationInit.init("rightMatch");
    externalJoinSchema.tables.left.relations["rightMatch"] = relation;

    const createData = createUow();
    createData.create("left", {
      id: "left-1",
      label: "Left One",
    });
    createData.create("left", {
      id: "shared-id",
      label: "Left Shared",
    });
    createData.create("right", {
      id: "shared-id",
      label: "Right Shared",
    });
    await createData.executeMutations();

    const query = createUow();
    query.findNew("left", (b) =>
      b
        .whereIndex("primary", (eb) => eb("id", "=", "shared-id"))
        .joinOne("rightMatch", "right", (rb) =>
          rb.onIndex("primary", (eb) => eb("id", "=", eb.parent("id"))).select(["id", "label"]),
        ),
    );

    const [rows] = (await query.executeRetrieve()) as Array<
      Array<{ rightMatch?: { id: { externalId: string }; label: string } }>
    >;

    expect(rows).toHaveLength(1);
    expect(rows[0].rightMatch).toMatchObject({
      id: expect.objectContaining({ externalId: "shared-id" }),
      label: "Right Shared",
    });
  });

  it("supports query-tree joins without schema relations", async () => {
    const { createUow } = createHarness();

    const createData = createUow();
    createData.create("users", {
      id: "user-1",
      name: "Ada",
      email: "ada@example.com",
    });
    createData.create("users", {
      id: "user-2",
      name: "Grace",
      email: "grace@example.com",
    });
    createData.create("memberships", {
      id: "membership-1",
      userId: "user-1",
    });
    createData.create("memberships", {
      id: "membership-2",
      userId: "user-1",
    });
    createData.create("memberships", {
      id: "membership-3",
      userId: "user-2",
    });
    await createData.executeMutations();

    const query = createUow();
    query.findNew("users", (q) =>
      q
        .whereIndex("primary", (eb) => eb("id", "=", "user-1"))
        .select(["id", "name"])
        .joinMany("memberships", "memberships", (memberships) =>
          memberships
            .onIndex("idx_memberships_user", (eb) => eb("userId", "=", eb.parent("id")))
            .select(["id", "userId"])
            .joinOne("memberUser", "users", (memberUser) =>
              memberUser
                .onIndex("primary", (eb) => eb("id", "=", eb.parent("userId")))
                .select(["id", "name"]),
            ),
        ),
    );

    const [users] = (await query.executeRetrieve()) as Array<
      Array<{
        id: { externalId: string };
        name: string;
        memberships: Array<{
          id: { externalId: string };
          memberUser: { id: { externalId: string }; name: string } | null;
        }>;
      }>
    >;

    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      id: expect.objectContaining({ externalId: "user-1" }),
      name: "Ada",
      memberships: expect.arrayContaining([
        expect.objectContaining({
          id: expect.objectContaining({ externalId: "membership-1" }),
          memberUser: expect.objectContaining({
            id: expect.objectContaining({ externalId: "user-1" }),
            name: "Ada",
          }),
        }),
        expect.objectContaining({
          id: expect.objectContaining({ externalId: "membership-2" }),
          memberUser: expect.objectContaining({
            id: expect.objectContaining({ externalId: "user-1" }),
            name: "Ada",
          }),
        }),
      ]),
    });
  });

  it("supports findFirstNew and child whereIndex filtering", async () => {
    const { createUow } = createHarness();

    const createData = createUow();
    createData.create("users", {
      id: "user-1",
      name: "Ada",
      email: "ada@example.com",
    });
    createData.create("users", {
      id: "user-2",
      name: "Grace",
      email: "grace@example.com",
    });
    createData.create("memberships", {
      id: "membership-1",
      userId: "user-1",
    });
    await createData.executeMutations();

    const query = createUow();
    query.findFirstNew("users", (q) =>
      q
        .whereIndex("idx_users_name", (eb) => eb("name", "=", "Ada"))
        .select(["id", "name"])
        .joinMany("memberships", "memberships", (memberships) =>
          memberships
            .onIndex("idx_memberships_user", (eb) => eb("userId", "=", eb.parent("id")))
            .select(["id", "userId"])
            .joinOne("memberUser", "users", (memberUser) =>
              memberUser
                .onIndex("primary", (eb) => eb("id", "=", eb.parent("userId")))
                .whereIndex("idx_users_name", (eb) => eb("name", "=", "Ada"))
                .select(["id", "name"]),
            ),
        ),
    );

    const [[user]] = (await query.executeRetrieve()) as Array<
      [
        {
          id: { externalId: string };
          name: string;
          memberships: Array<{
            id: { externalId: string };
            memberUser: { id: { externalId: string }; name: string } | null;
          }>;
        } | null,
      ]
    >;

    expect(user).toMatchObject({
      id: expect.objectContaining({ externalId: "user-1" }),
      name: "Ada",
      memberships: [
        {
          id: expect.objectContaining({ externalId: "membership-1" }),
          memberUser: {
            id: expect.objectContaining({ externalId: "user-1" }),
            name: "Ada",
          },
        },
      ],
    });
  });

  it("applies page size after filtering primary-index lookups", async () => {
    const { createUow } = createHarness();

    const createData = createUow();
    createData.create("users", {
      id: "user-1",
      name: "Ada",
      email: "ada@example.com",
    });
    createData.create("users", {
      id: "user-2",
      name: "Grace",
      email: "grace@example.com",
    });
    await createData.executeMutations();

    const query = createUow();
    query.findFirstNew("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", "user-2")));

    const [[user]] = (await query.executeRetrieve()) as Array<
      [
        {
          id: { externalId: string };
          name: string;
        } | null,
      ]
    >;

    expect(user).toMatchObject({
      id: expect.objectContaining({ externalId: "user-2" }),
      name: "Grace",
    });
  });
});
