import { describe, expect, it } from "vitest";

import type { CompiledJoin } from "../../query/find-options";
import { createShardQueryPolicy } from "../../query/unit-of-work/query-policies";
import {
  UnitOfWork,
  type RetrievalOperation,
  type UnitOfWorkConfig,
} from "../../query/unit-of-work/unit-of-work";
import { column, getTableRelations, idColumn, referenceColumn, schema } from "../../schema/create";
import { InMemoryAdapter } from "./in-memory-adapter";
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

const shardSchema = schema("shard", (s) =>
  s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
);

const createShardPolicyConfig = (options: {
  shardingStrategy?: { mode: "row" } | { mode: "adapter"; identifier: string };
  shard: string | null;
  shardScope?: "scoped" | "global";
}): UnitOfWorkConfig => ({
  queryPolicies: [
    {
      policy: createShardQueryPolicy({
        shardingStrategy: options.shardingStrategy,
        getShard: () => options.shard,
        getShardScope: () => options.shardScope ?? "scoped",
      }),
      getContext: () => ({}),
    },
  ],
});

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

const createShardHarness = () => {
  const store = createInMemoryStore();
  const options = resolveInMemoryAdapterOptions({ idSeed: "seed" });
  const compiler = createInMemoryUowCompiler();
  const executor = createInMemoryUowExecutor(store, options);
  const decoder = new InMemoryUowDecoder();

  return {
    createUow: (config?: UnitOfWorkConfig) =>
      new UnitOfWork(compiler, executor, decoder, undefined, config).forSchema(shardSchema),
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
      policyWhere: null,
    } satisfies RetrievalOperation<typeof joinSchema>;

    await expect(executor.executeRetrievalPhase([op])).rejects.toThrow(
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

    const query = createUow().find("users", (b) =>
      b
        .whereIndex("primary", (eb) => eb("id", "=", "user-1"))
        .joinMany("memberships", "memberships", (mb) =>
          mb
            .onIndex("idx_memberships_user", (eb) => eb("userId", "=", eb.parent("id")))
            .select(["id"]),
        ),
    );

    const [users] = await query.executeRetrieve();

    expect(users).toHaveLength(1);
    expect(users[0].memberships).toMatchObject([
      {
        id: expect.objectContaining({ externalId: "membership-1" }),
      },
    ]);
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

    const query = createUow().find("users", (q) =>
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

    const [users] = await query.executeRetrieve();

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

  it("supports findFirst and child whereIndex filtering", async () => {
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

    const query = createUow().findFirst("users", (q) =>
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

    const [user] = await query.executeRetrieve();

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

    const query = createUow().findFirst("users", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", "user-2")),
    );

    const [user] = await query.executeRetrieve();

    expect(user).toMatchObject({
      id: expect.objectContaining({ externalId: "user-2" }),
      name: "Grace",
    });
  });

  it("preserves explicit shard policy config when creating base UOWs", async () => {
    const adapter = new InMemoryAdapter({ idSeed: "seed" });
    adapter.registerSchema(shardSchema, null);
    const shardingStrategy = { mode: "row" } as const;

    const createShardA = adapter
      .createBaseUnitOfWork(
        undefined,
        createShardPolicyConfig({ shardingStrategy, shard: "shard-a" }),
      )
      .forSchema(shardSchema);
    createShardA.create("users", { name: "Alice" });
    await createShardA.executeMutations();

    const createShardB = adapter
      .createBaseUnitOfWork(
        undefined,
        createShardPolicyConfig({ shardingStrategy, shard: "shard-b" }),
      )
      .forSchema(shardSchema);
    createShardB.create("users", { name: "Bob" });
    await createShardB.executeMutations();

    const findShardA = adapter
      .createBaseUnitOfWork(
        undefined,
        createShardPolicyConfig({ shardingStrategy, shard: "shard-a" }),
      )
      .forSchema(shardSchema);
    findShardA.find("users", (b) => b.whereIndex("primary"));

    const results = (await findShardA.executeRetrieve()) as unknown[];
    const names = (results[0] as { name: string }[]).map((row) => row.name);
    expect(names).toEqual(["Alice"]);
  });

  it("filters find and count operations by shard in row mode", async () => {
    const { createUow } = createShardHarness();
    const shardingStrategy = { mode: "row" } as const;

    const createShardA = createUow(createShardPolicyConfig({ shardingStrategy, shard: "shard-a" }));
    createShardA.create("users", { id: "user-a", name: "Ada" });
    await createShardA.executeMutations();

    const createShardB = createUow(createShardPolicyConfig({ shardingStrategy, shard: "shard-b" }));
    createShardB.create("users", { id: "user-b", name: "Bea" });
    await createShardB.executeMutations();

    const findShardA = createUow(createShardPolicyConfig({ shardingStrategy, shard: "shard-a" }));
    findShardA.find("users", (b) => b.whereIndex("primary"));
    const findResults = (await findShardA.executeRetrieve()) as unknown[];
    const names = (findResults[0] as { name: string }[]).map((row) => row.name);
    expect(names).toEqual(["Ada"]);

    const countShardB = createUow(createShardPolicyConfig({ shardingStrategy, shard: "shard-b" }));
    countShardB.find("users", (b) => b.whereIndex("primary").selectCount());
    const countResults = (await countShardB.executeRetrieve()) as unknown[];
    expect(countResults[0]).toBe(1);
  });

  it("skips shard filtering when shardScope is global", async () => {
    const { createUow } = createShardHarness();
    const shardingStrategy = { mode: "row" } as const;

    const createShardA = createUow(createShardPolicyConfig({ shardingStrategy, shard: "shard-a" }));
    createShardA.create("users", { id: "user-a", name: "Ada" });
    await createShardA.executeMutations();

    const createShardB = createUow(createShardPolicyConfig({ shardingStrategy, shard: "shard-b" }));
    createShardB.create("users", { id: "user-b", name: "Bea" });
    await createShardB.executeMutations();

    const globalFind = createUow(
      createShardPolicyConfig({
        shardingStrategy,
        shard: "shard-a",
        shardScope: "global",
      }),
    );
    globalFind.find("users", (b) => b.whereIndex("primary"));
    const results = (await globalFind.executeRetrieve()) as unknown[];
    expect(results[0]).toHaveLength(2);
  });

  it("filters joined table rows by shard in row mode", async () => {
    const { createUow } = createJoinShardHarness();
    const shardingStrategy = { mode: "row" } as const;

    const createShardB = createUow(createShardPolicyConfig({ shardingStrategy, shard: "shard-b" }));
    createShardB.create("users", {
      id: "user-b",
      name: "Bea",
      email: "bea@example.com",
    });
    await createShardB.executeMutations();

    const createShardA = createUow(createShardPolicyConfig({ shardingStrategy, shard: "shard-a" }));
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

    const findShardA = createUow(createShardPolicyConfig({ shardingStrategy, shard: "shard-a" }));
    findShardA.find("posts", (q) =>
      q
        .whereIndex("primary")
        .joinOne("author", "users", (author) =>
          author.onIndex("primary", (eb) => eb("id", "=", eb.parent("authorId"))).select(["name"]),
        ),
    );
    const results = (await findShardA.executeRetrieve()) as unknown[];
    const rows = results[0] as Array<{ title: string; author?: { name: string } }>;

    const sameShard = rows.find((row) => row.title === "Post A");
    const crossShard = rows.find((row) => row.title === "Cross");

    expect(sameShard?.author?.name).toBe("Ada");
    expect(crossShard?.author).toBeNull();
  });
});
