import { describe, expect, it } from "vitest";
import { column, FragnoId, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";
import { InMemoryLofiAdapter } from "../in-memory/adapter";
import type { LofiAdapter, LofiQueryableAdapter } from "../../types";
import { createStackedQueryEngine } from "./merge";

const createStackedQuery = (appSchema: ReturnType<typeof schema>) => {
  const base = new InMemoryLofiAdapter({ endpointName: "app", schemas: [appSchema] });
  const overlay = new InMemoryLofiAdapter({ endpointName: "app", schemas: [appSchema] });
  const query = createStackedQueryEngine({ schema: appSchema, base, overlay });

  return { base, overlay, query };
};

const createStubBaseAdapter = (
  rowsByTable: Record<string, Record<string, unknown>[]>,
): LofiAdapter & LofiQueryableAdapter => {
  const query = {
    find: async (table: string) => rowsByTable[table] ?? [],
    findFirst: async (table: string) => (rowsByTable[table] ?? [])[0] ?? null,
    findWithCursor: async (table: string) => ({
      items: rowsByTable[table] ?? [],
      cursor: undefined,
      hasNextPage: false,
    }),
  };

  return {
    applyOutboxEntry: async () => ({ applied: true }),
    getMeta: async () => undefined,
    setMeta: async () => {},
    createQueryEngine: () => query,
  } as LofiAdapter & LofiQueryableAdapter;
};

describe("stacked merge", () => {
  it("backfills base joins for overlay-only rows", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
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
        }),
    );

    const { base, overlay, query } = createStackedQuery(appSchema);

    await base.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-vs1",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada" },
        },
      ],
    });

    await overlay.applyMutations([
      {
        op: "create",
        schema: "app",
        table: "posts",
        externalId: "post-1",
        versionstamp: "vs2",
        values: { title: "Hello", authorId: "user-1" },
      },
    ]);

    const joined = await query.find("posts", (b) =>
      b.whereIndex("idx_author").join((j) => j["author"]()),
    );

    expect(joined).toHaveLength(1);
    const author = (joined[0] as Record<string, unknown>)["author"] as
      | { name?: string }
      | null
      | undefined;
    expect(author?.name).toBe("Ada");
  });

  it("applies join select when backfilling overlay-only rows", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("name", column("string"))
            .addColumn("email", column("string")),
        )
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
        }),
    );

    const { base, overlay, query } = createStackedQuery(appSchema);

    await base.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-vs1",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada", email: "ada@example.com" },
        },
      ],
    });

    await overlay.applyMutations([
      {
        op: "create",
        schema: "app",
        table: "posts",
        externalId: "post-1",
        versionstamp: "vs2",
        values: { title: "Hello", authorId: "user-1" },
      },
    ]);

    const posts = await query.find("posts", (b) =>
      b.whereIndex("idx_author").join((j) => j["author"]((jb) => jb.select(["name"]))),
    );

    expect(posts).toHaveLength(1);
    const author = (posts[0] as Record<string, unknown>)["author"] as
      | Record<string, unknown>
      | null
      | undefined;
    expect(author?.["name"]).toBe("Ada");
    expect(author && "email" in author).toBe(false);
    expect(author && "id" in author).toBe(false);
  });

  it("keeps array joins intact when overlay patches a single entry", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("authorId", referenceColumn())
            .addColumn("title", column("string")),
        )
        .addReference("posts", {
          type: "many",
          from: { table: "users", column: "id" },
          to: { table: "posts", column: "authorId" },
        }),
    );

    const base = createStubBaseAdapter({
      users: [
        {
          id: "user-1",
          name: "Ada",
          posts: [
            { id: "post-1", title: "First", authorId: "user-1" },
            { id: "post-2", title: "Second", authorId: "user-1" },
          ],
        },
      ],
    });
    const overlay = new InMemoryLofiAdapter({ endpointName: "app", schemas: [appSchema] });
    const query = createStackedQueryEngine({ schema: appSchema, base, overlay });

    await overlay.applyMutations([
      {
        op: "create",
        schema: "app",
        table: "posts",
        externalId: "post-1",
        versionstamp: "vs2",
        values: { title: "Updated", authorId: "user-1" },
      },
    ]);

    const users = await query.find("users", (b) =>
      b.whereIndex("primary").join((j) => j["posts"]()),
    );

    expect(users).toHaveLength(1);
    const posts = (users[0] as Record<string, unknown>)["posts"] as Array<Record<string, unknown>>;
    expect(posts).toHaveLength(2);
    const titles = posts.map((post) => post["title"] as string | undefined).sort();
    expect(titles).toEqual(["Second", "Updated"]);
  });

  it("orders and limits backfilled many joins", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("authorId", referenceColumn())
            .addColumn("title", column("string"))
            .createIndex("idx_title", ["title"]),
        )
        .addReference("posts", {
          type: "many",
          from: { table: "users", column: "id" },
          to: { table: "posts", column: "authorId" },
        }),
    );

    const base = createStubBaseAdapter({
      posts: [
        { id: "post-1", title: "Alpha", authorId: "user-1" },
        { id: "post-2", title: "Gamma", authorId: "user-1" },
        { id: "post-3", title: "Beta", authorId: "user-1" },
      ],
    });
    const overlay = new InMemoryLofiAdapter({ endpointName: "app", schemas: [appSchema] });
    const query = createStackedQueryEngine({ schema: appSchema, base, overlay });

    await overlay.applyMutations([
      {
        op: "create",
        schema: "app",
        table: "users",
        externalId: "user-1",
        versionstamp: "vs1",
        values: { name: "Ada" },
      },
    ]);

    const users = await query.find("users", (b) =>
      b
        .whereIndex("primary")
        .join((j) => j["posts"]((jb) => jb.orderByIndex("idx_title", "desc").pageSize(2))),
    );

    expect(users).toHaveLength(1);
    const posts = (users[0] as Record<string, unknown>)["posts"] as Array<Record<string, unknown>>;
    const titles = posts.map((post) => post["title"] as string);
    expect(titles).toEqual(["Gamma", "Beta"]);
  });

  it("removes tombstoned entries from array joins", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("authorId", referenceColumn())
            .addColumn("title", column("string")),
        )
        .addReference("posts", {
          type: "many",
          from: { table: "users", column: "id" },
          to: { table: "posts", column: "authorId" },
        }),
    );

    const base = createStubBaseAdapter({
      users: [
        {
          id: "user-1",
          name: "Ada",
          posts: [
            { id: "post-1", title: "First", authorId: "user-1" },
            { id: "post-2", title: "Second", authorId: "user-1" },
          ],
        },
      ],
    });
    const overlay = new InMemoryLofiAdapter({ endpointName: "app", schemas: [appSchema] });
    const query = createStackedQueryEngine({ schema: appSchema, base, overlay });

    await overlay.applyMutations([
      {
        op: "delete",
        schema: "app",
        table: "posts",
        externalId: "post-1",
        versionstamp: "vs2",
      },
    ]);

    const users = await query.find("users", (b) =>
      b.whereIndex("primary").join((j) => j["posts"]()),
    );

    expect(users).toHaveLength(1);
    const posts = (users[0] as Record<string, unknown>)["posts"] as Array<Record<string, unknown>>;
    expect(posts).toHaveLength(1);
    expect(posts[0]?.["title"]).toBe("Second");
  });

  it("patches nested joins from overlay rows", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("authorId", referenceColumn())
            .addColumn("title", column("string")),
        )
        .addTable("comments", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("postId", referenceColumn())
            .addColumn("body", column("string")),
        )
        .addReference("posts", {
          type: "many",
          from: { table: "users", column: "id" },
          to: { table: "posts", column: "authorId" },
        })
        .addReference("comments", {
          type: "many",
          from: { table: "posts", column: "id" },
          to: { table: "comments", column: "postId" },
        }),
    );

    const base = createStubBaseAdapter({
      users: [
        {
          id: "user-1",
          name: "Ada",
          posts: [
            {
              id: "post-1",
              title: "Hello",
              authorId: "user-1",
              comments: [{ id: "comment-1", body: "First", postId: "post-1" }],
            },
          ],
        },
      ],
    });
    const overlay = new InMemoryLofiAdapter({ endpointName: "app", schemas: [appSchema] });
    const query = createStackedQueryEngine({ schema: appSchema, base, overlay });

    await overlay.applyMutations([
      {
        op: "create",
        schema: "app",
        table: "comments",
        externalId: "comment-1",
        versionstamp: "vs2",
        values: { body: "Updated", postId: "post-1" },
      },
    ]);

    const users = await query.find("users", (b) =>
      b.whereIndex("primary").join((j) => j["posts"]((pb) => pb.join((pj) => pj["comments"]()))),
    );

    expect(users).toHaveLength(1);
    const posts = (users[0] as Record<string, unknown>)["posts"] as Array<Record<string, unknown>>;
    expect(posts).toHaveLength(1);
    const comments = posts[0]?.["comments"] as Array<Record<string, unknown>> | undefined;
    expect(comments?.[0]?.["body"]).toBe("Updated");
  });

  it("respects join filters when backfilling overlay-only rows", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("name", column("string"))
            .createIndex("idx_name", ["name"]),
        )
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("authorId", referenceColumn())
            .addColumn("title", column("string")),
        )
        .addReference("author", {
          type: "one",
          from: { table: "posts", column: "authorId" },
          to: { table: "users", column: "id" },
        }),
    );

    const { base, overlay, query } = createStackedQuery(appSchema);

    await base.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-vs1",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada" },
        },
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-2",
          versionstamp: "vs1",
          values: { name: "Grace" },
        },
      ],
    });

    await overlay.applyMutations([
      {
        op: "create",
        schema: "app",
        table: "posts",
        externalId: "post-1",
        versionstamp: "vs2",
        values: { title: "Hello", authorId: "user-1" },
      },
      {
        op: "create",
        schema: "app",
        table: "posts",
        externalId: "post-2",
        versionstamp: "vs2",
        values: { title: "Hi", authorId: "user-2" },
      },
    ]);

    const posts = await query.find("posts", (b) =>
      b
        .whereIndex("primary")
        .join((j) =>
          j["author"]((jb) => jb.whereIndex("idx_name", (eb) => eb("name", "=", "Ada"))),
        ),
    );

    const adaPost = posts.find((post) => {
      const id = (post as Record<string, unknown>)["id"] as
        | { externalId?: string }
        | null
        | undefined;
      return id?.externalId === "post-1";
    });
    const gracePost = posts.find((post) => {
      const id = (post as Record<string, unknown>)["id"] as
        | { externalId?: string }
        | null
        | undefined;
      return id?.externalId === "post-2";
    });

    const adaAuthor = adaPost
      ? ((adaPost as Record<string, unknown>)["author"] as { name?: string } | null | undefined)
      : undefined;
    const graceAuthor = gracePost
      ? ((gracePost as Record<string, unknown>)["author"] as unknown)
      : undefined;

    expect(adaAuthor?.name).toBe("Ada");
    expect(graceAuthor ?? null).toBeNull();
  });

  it("does not apply overlay patches when join select omits id", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
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
        }),
    );

    const { base, overlay, query } = createStackedQuery(appSchema);

    await base.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-vs1",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada" },
        },
        {
          op: "create",
          schema: "app",
          table: "posts",
          externalId: "post-1",
          versionstamp: "vs1",
          values: { title: "Hello", authorId: "user-1" },
        },
      ],
    });

    await overlay.applyMutations([
      {
        op: "update",
        schema: "app",
        table: "users",
        externalId: "user-1",
        versionstamp: "vs2",
        set: { name: "Grace" },
      },
    ]);

    const posts = await query.find("posts", (b) =>
      b.whereIndex("idx_author").join((j) => j["author"]((jb) => jb.select(["name"]))),
    );

    expect(posts).toHaveLength(1);
    const author = (posts[0] as Record<string, unknown>)["author"] as
      | Record<string, unknown>
      | null
      | undefined;
    expect(author?.["name"]).toBe("Ada");
  });

  it("moves joins when overlay updates the foreign key", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
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
        }),
    );

    const { base, overlay, query } = createStackedQuery(appSchema);

    await base.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-vs1",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada" },
        },
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-2",
          versionstamp: "vs1",
          values: { name: "Grace" },
        },
        {
          op: "create",
          schema: "app",
          table: "posts",
          externalId: "post-1",
          versionstamp: "vs1",
          values: { title: "Hello", authorId: "user-1" },
        },
      ],
    });

    await overlay.applyMutations([
      {
        op: "create",
        schema: "app",
        table: "posts",
        externalId: "post-1",
        versionstamp: "vs2",
        values: { title: "Hello", authorId: "user-2" },
      },
    ]);

    const posts = await query.find("posts", (b) =>
      b.whereIndex("idx_author").join((j) => j["author"]()),
    );

    expect(posts).toHaveLength(1);
    const author = (posts[0] as Record<string, unknown>)["author"] as
      | Record<string, unknown>
      | null
      | undefined;
    expect(author?.["name"]).toBe("Grace");
  });

  it("matches composite joins", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("orgId", referenceColumn())
            .addColumn("email", column("string"))
            .createIndex("idx_user_org_email", ["orgId", "email"]),
        )
        .addTable("memberships", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("orgId", referenceColumn())
            .addColumn("userEmail", column("string"))
            .createIndex("idx_membership_org_email", ["orgId", "userEmail"]),
        )
        .addReference("member", {
          type: "one",
          from: { table: "memberships", column: "orgId" },
          to: { table: "users", column: "orgId" },
        }),
    );

    const relation = appSchema.tables.memberships.relations.member as {
      on: Array<[string, string]>;
    };
    relation.on.push(["userEmail", "email"]);

    const base = createStubBaseAdapter({
      users: [
        { id: "user-1", orgId: "org-1", email: "ada@example.com" },
        { id: "user-2", orgId: "org-1", email: "grace@example.com" },
      ],
    });
    const overlay = new InMemoryLofiAdapter({ endpointName: "app", schemas: [appSchema] });
    const query = createStackedQueryEngine({ schema: appSchema, base, overlay });

    await overlay.applyMutations([
      {
        op: "create",
        schema: "app",
        table: "memberships",
        externalId: "membership-1",
        versionstamp: "vs1",
        values: { orgId: "org-1", userEmail: "grace@example.com" },
      },
    ]);

    const memberships = await query.find("memberships", (b) =>
      b.whereIndex("primary").join((j) => j["member"]()),
    );

    const member = (memberships[0] as Record<string, unknown>)["member"] as
      | Record<string, unknown>
      | null
      | undefined;
    expect(member?.["email"]).toBe("grace@example.com");
  });

  it("supports join filters using external IDs", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("authorId", referenceColumn())
            .addColumn("title", column("string")),
        )
        .addReference("author", {
          type: "one",
          from: { table: "posts", column: "authorId" },
          to: { table: "users", column: "id" },
        }),
    );

    const { base, overlay: _overlay, query } = createStackedQuery(appSchema);

    await base.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-vs1",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada" },
        },
        {
          op: "create",
          schema: "app",
          table: "posts",
          externalId: "post-1",
          versionstamp: "vs1",
          values: { title: "Hello", authorId: "user-1" },
        },
      ],
    });

    const posts = await query.find("posts", (b) =>
      b
        .whereIndex("primary")
        .join((j) =>
          j["author"]((jb) =>
            jb.whereIndex("primary", (eb) =>
              (eb as unknown as (col: string, op: "=", value: string) => boolean)(
                "id",
                "=",
                "user-1",
              ),
            ),
          ),
        ),
    );

    const author = (posts[0] as Record<string, unknown>)["author"] as
      | Record<string, unknown>
      | null
      | undefined;
    expect(author?.["name"]).toBe("Ada");
  });

  it("paginates join results without dropping overlay rows", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("name", column("string"))
            .createIndex("idx_name", ["name"]),
        )
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
        }),
    );

    const { base, overlay: _overlay, query } = createStackedQuery(appSchema);

    await base.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-vs1",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada" },
        },
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-2",
          versionstamp: "vs1",
          values: { name: "Grace" },
        },
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-3",
          versionstamp: "vs1",
          values: { name: "Linus" },
        },
        {
          op: "create",
          schema: "app",
          table: "posts",
          externalId: "post-1",
          versionstamp: "vs1",
          values: { title: "Hello", authorId: "user-1" },
        },
        {
          op: "create",
          schema: "app",
          table: "posts",
          externalId: "post-2",
          versionstamp: "vs1",
          values: { title: "Hi", authorId: "user-2" },
        },
        {
          op: "create",
          schema: "app",
          table: "posts",
          externalId: "post-3",
          versionstamp: "vs1",
          values: { title: "Yo", authorId: "user-3" },
        },
      ],
    });

    const firstPage = await query.findWithCursor("posts", (b) =>
      b
        .whereIndex("primary")
        .orderByIndex("primary", "asc")
        .pageSize(2)
        .join((j) =>
          j["author"]((jb) => jb.whereIndex("idx_name").orderByIndex("idx_name", "asc")),
        ),
    );

    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.hasNextPage).toBe(true);

    const secondPage = await query.findWithCursor("posts", (b) =>
      b
        .whereIndex("primary")
        .orderByIndex("primary", "asc")
        .pageSize(2)
        .after(firstPage.cursor!)
        .join((j) => j["author"]()),
    );

    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.hasNextPage).toBe(false);
  });

  it("returns null joins when the referenced base row is missing", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
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
        }),
    );

    const { overlay, query } = createStackedQuery(appSchema);

    await overlay.applyMutations([
      {
        op: "create",
        schema: "app",
        table: "posts",
        externalId: "post-1",
        versionstamp: "vs1",
        values: { title: "Hello", authorId: "user-missing" },
      },
    ]);

    const posts = await query.find("posts", (b) =>
      b.whereIndex("idx_author").join((j) => j["author"]()),
    );

    const author = (posts[0] as Record<string, unknown>)["author"] as unknown;
    expect(author ?? null).toBeNull();
  });

  it("supports join filters with contains", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("name", column("string"))
            .createIndex("idx_name", ["name"]),
        )
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
        }),
    );

    const { base, overlay, query } = createStackedQuery(appSchema);

    await base.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-vs1",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada Lovelace" },
        },
      ],
    });

    await overlay.applyMutations([
      {
        op: "create",
        schema: "app",
        table: "posts",
        externalId: "post-1",
        versionstamp: "vs2",
        values: { title: "Hello", authorId: "user-1" },
      },
    ]);

    const posts = await query.find("posts", (b) =>
      b
        .whereIndex("idx_author")
        .join((j) =>
          j["author"]((jb) => jb.whereIndex("idx_name", (eb) => eb("name", "contains", "love"))),
        ),
    );

    const author = (posts[0] as Record<string, unknown>)["author"] as
      | Record<string, unknown>
      | null
      | undefined;
    expect(author?.["name"]).toBe("Ada Lovelace");
  });

  it("supports join filters with not in", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("name", column("string"))
            .createIndex("idx_name", ["name"]),
        )
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
        }),
    );

    const { base, overlay, query } = createStackedQuery(appSchema);

    await base.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-vs1",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada" },
        },
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-2",
          versionstamp: "vs1",
          values: { name: "Grace" },
        },
      ],
    });

    await overlay.applyMutations([
      {
        op: "create",
        schema: "app",
        table: "posts",
        externalId: "post-1",
        versionstamp: "vs2",
        values: { title: "Hello", authorId: "user-1" },
      },
      {
        op: "create",
        schema: "app",
        table: "posts",
        externalId: "post-2",
        versionstamp: "vs2",
        values: { title: "Hi", authorId: "user-2" },
      },
    ]);

    const posts = await query.find("posts", (b) =>
      b
        .whereIndex("primary")
        .join((j) =>
          j["author"]((jb) => jb.whereIndex("idx_name", (eb) => eb("name", "not in", ["Grace"]))),
        ),
    );

    const adaPost = posts.find((post) => {
      const id = (post as Record<string, unknown>)["id"] as
        | { externalId?: string }
        | null
        | undefined;
      return id?.externalId === "post-1";
    });
    const gracePost = posts.find((post) => {
      const id = (post as Record<string, unknown>)["id"] as
        | { externalId?: string }
        | null
        | undefined;
      return id?.externalId === "post-2";
    });

    const adaAuthor = adaPost
      ? ((adaPost as Record<string, unknown>)["author"] as
          | Record<string, unknown>
          | null
          | undefined)
      : undefined;
    const graceAuthor = gracePost
      ? ((gracePost as Record<string, unknown>)["author"] as unknown)
      : undefined;

    expect(adaAuthor?.["name"]).toBe("Ada");
    expect(graceAuthor ?? null).toBeNull();
  });

  it("applies nested join filters on backfill", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("orgs", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("name", column("string"))
            .createIndex("idx_name", ["name"]),
        )
        .addTable("users", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("orgId", referenceColumn())
            .addColumn("name", column("string"))
            .createIndex("idx_org", ["orgId"]),
        )
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
        })
        .addReference("org", {
          type: "one",
          from: { table: "users", column: "orgId" },
          to: { table: "orgs", column: "id" },
        }),
    );

    const { base, overlay, query } = createStackedQuery(appSchema);

    await base.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-vs1",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "orgs",
          externalId: "org-1",
          versionstamp: "vs1",
          values: { name: "Org A" },
        },
        {
          op: "create",
          schema: "app",
          table: "orgs",
          externalId: "org-2",
          versionstamp: "vs1",
          values: { name: "Org B" },
        },
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada", orgId: "org-1" },
        },
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-2",
          versionstamp: "vs1",
          values: { name: "Grace", orgId: "org-2" },
        },
      ],
    });

    await overlay.applyMutations([
      {
        op: "create",
        schema: "app",
        table: "posts",
        externalId: "post-1",
        versionstamp: "vs2",
        values: { title: "Hello", authorId: "user-1" },
      },
      {
        op: "create",
        schema: "app",
        table: "posts",
        externalId: "post-2",
        versionstamp: "vs2",
        values: { title: "Hi", authorId: "user-2" },
      },
    ]);

    const posts = await query.find("posts", (b) =>
      b
        .whereIndex("primary")
        .join((j) =>
          j["author"]((jb) =>
            jb.join((oj) =>
              oj["org"]((ob) => ob.whereIndex("idx_name", (eb) => eb("name", "=", "Org A"))),
            ),
          ),
        ),
    );

    const post1 = posts.find((post) => {
      const id = (post as Record<string, unknown>)["id"] as
        | { externalId?: string }
        | null
        | undefined;
      return id?.externalId === "post-1";
    });
    const post2 = posts.find((post) => {
      const id = (post as Record<string, unknown>)["id"] as
        | { externalId?: string }
        | null
        | undefined;
      return id?.externalId === "post-2";
    });

    const author1 = post1
      ? ((post1 as Record<string, unknown>)["author"] as Record<string, unknown> | null | undefined)
      : undefined;
    const author2 = post2
      ? ((post2 as Record<string, unknown>)["author"] as Record<string, unknown> | null | undefined)
      : undefined;

    const org1 = author1
      ? ((author1 as Record<string, unknown>)["org"] as Record<string, unknown> | null | undefined)
      : undefined;
    const org2 = author2
      ? ((author2 as Record<string, unknown>)["org"] as Record<string, unknown> | null | undefined)
      : undefined;

    expect(org1?.["name"]).toBe("Org A");
    expect(org2 ?? null).toBeNull();
  });

  it("supports join filters with comparison operators", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("name", column("string"))
            .addColumn("age", column("integer"))
            .createIndex("idx_age", ["age"]),
        )
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("authorId", referenceColumn())
            .addColumn("title", column("string")),
        )
        .addReference("author", {
          type: "one",
          from: { table: "posts", column: "authorId" },
          to: { table: "users", column: "id" },
        }),
    );

    const { base, overlay, query } = createStackedQuery(appSchema);

    await base.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-vs1",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada", age: 20 },
        },
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-2",
          versionstamp: "vs1",
          values: { name: "Grace", age: 35 },
        },
      ],
    });

    await overlay.applyMutations([
      {
        op: "create",
        schema: "app",
        table: "posts",
        externalId: "post-1",
        versionstamp: "vs2",
        values: { title: "Hello", authorId: "user-1" },
      },
      {
        op: "create",
        schema: "app",
        table: "posts",
        externalId: "post-2",
        versionstamp: "vs2",
        values: { title: "Hi", authorId: "user-2" },
      },
    ]);

    const posts = await query.find("posts", (b) =>
      b
        .whereIndex("primary")
        .join((j) => j["author"]((jb) => jb.whereIndex("idx_age", (eb) => eb("age", ">", 25)))),
    );

    const youngPost = posts.find((post) => {
      const id = (post as Record<string, unknown>)["id"] as
        | { externalId?: string }
        | null
        | undefined;
      return id?.externalId === "post-1";
    });
    const maturePost = posts.find((post) => {
      const id = (post as Record<string, unknown>)["id"] as
        | { externalId?: string }
        | null
        | undefined;
      return id?.externalId === "post-2";
    });

    const youngAuthor = youngPost
      ? ((youngPost as Record<string, unknown>)["author"] as
          | Record<string, unknown>
          | null
          | undefined)
      : undefined;
    const matureAuthor = maturePost
      ? ((maturePost as Record<string, unknown>)["author"] as
          | Record<string, unknown>
          | null
          | undefined)
      : undefined;

    expect(youngAuthor ?? null).toBeNull();
    expect(matureAuthor?.["name"]).toBe("Grace");
  });

  it("supports join filters with string negation operators", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("name", column("string"))
            .createIndex("idx_name", ["name"]),
        )
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("authorId", referenceColumn())
            .addColumn("title", column("string")),
        )
        .addReference("author", {
          type: "one",
          from: { table: "posts", column: "authorId" },
          to: { table: "users", column: "id" },
        }),
    );

    const { base, overlay, query } = createStackedQuery(appSchema);

    await base.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-vs1",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada Lovelace" },
        },
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-2",
          versionstamp: "vs1",
          values: { name: "Grace Hopper" },
        },
      ],
    });

    await overlay.applyMutations([
      {
        op: "create",
        schema: "app",
        table: "posts",
        externalId: "post-1",
        versionstamp: "vs2",
        values: { title: "Hello", authorId: "user-1" },
      },
      {
        op: "create",
        schema: "app",
        table: "posts",
        externalId: "post-2",
        versionstamp: "vs2",
        values: { title: "Hi", authorId: "user-2" },
      },
    ]);

    const posts = await query.find("posts", (b) =>
      b
        .whereIndex("primary")
        .join((j) =>
          j["author"]((jb) => jb.whereIndex("idx_name", (eb) => eb("name", "not contains", "Ada"))),
        ),
    );

    const adaPost = posts.find((post) => {
      const id = (post as Record<string, unknown>)["id"] as
        | { externalId?: string }
        | null
        | undefined;
      return id?.externalId === "post-1";
    });
    const gracePost = posts.find((post) => {
      const id = (post as Record<string, unknown>)["id"] as
        | { externalId?: string }
        | null
        | undefined;
      return id?.externalId === "post-2";
    });

    const adaAuthor = adaPost
      ? ((adaPost as Record<string, unknown>)["author"] as
          | Record<string, unknown>
          | null
          | undefined)
      : undefined;
    const graceAuthor = gracePost
      ? ((gracePost as Record<string, unknown>)["author"] as
          | Record<string, unknown>
          | null
          | undefined)
      : undefined;

    expect(adaAuthor ?? null).toBeNull();
    expect(graceAuthor?.["name"]).toBe("Grace Hopper");
  });

  it("supports join filters with column comparisons", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("name", column("string"))
            .addColumn("minAge", column("integer"))
            .addColumn("maxAge", column("integer"))
            .createIndex("idx_min", ["minAge"]),
        )
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("authorId", referenceColumn())
            .addColumn("title", column("string")),
        )
        .addReference("author", {
          type: "one",
          from: { table: "posts", column: "authorId" },
          to: { table: "users", column: "id" },
        }),
    );

    const { base, overlay, query } = createStackedQuery(appSchema);

    await base.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-vs1",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada", minAge: 10, maxAge: 20 },
        },
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-2",
          versionstamp: "vs1",
          values: { name: "Grace", minAge: 40, maxAge: 30 },
        },
      ],
    });

    await overlay.applyMutations([
      {
        op: "create",
        schema: "app",
        table: "posts",
        externalId: "post-1",
        versionstamp: "vs2",
        values: { title: "Hello", authorId: "user-1" },
      },
      {
        op: "create",
        schema: "app",
        table: "posts",
        externalId: "post-2",
        versionstamp: "vs2",
        values: { title: "Hi", authorId: "user-2" },
      },
    ]);

    const posts = await query.find("posts", (b) =>
      b.whereIndex("primary").join((j) =>
        j["author"]((jb) =>
          jb.whereIndex("idx_min", (eb) => {
            const compare = eb as unknown as (col: string, op: "<=", value: unknown) => boolean;
            return compare("minAge", "<=", appSchema.tables.users.columns.maxAge);
          }),
        ),
      ),
    );

    const adaPost = posts.find((post) => {
      const id = (post as Record<string, unknown>)["id"] as
        | { externalId?: string }
        | null
        | undefined;
      return id?.externalId === "post-1";
    });
    const gracePost = posts.find((post) => {
      const id = (post as Record<string, unknown>)["id"] as
        | { externalId?: string }
        | null
        | undefined;
      return id?.externalId === "post-2";
    });

    const adaAuthor = adaPost
      ? ((adaPost as Record<string, unknown>)["author"] as
          | Record<string, unknown>
          | null
          | undefined)
      : undefined;
    const graceAuthor = gracePost
      ? ((gracePost as Record<string, unknown>)["author"] as
          | Record<string, unknown>
          | null
          | undefined)
      : undefined;

    expect(adaAuthor?.["name"]).toBe("Ada");
    expect(graceAuthor ?? null).toBeNull();
  });

  it("supports join filters with FragnoId values", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("authorId", referenceColumn())
            .addColumn("title", column("string")),
        )
        .addReference("author", {
          type: "one",
          from: { table: "posts", column: "authorId" },
          to: { table: "users", column: "id" },
        }),
    );

    const { base, overlay, query } = createStackedQuery(appSchema);

    await base.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-vs1",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada" },
        },
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-2",
          versionstamp: "vs1",
          values: { name: "Grace" },
        },
      ],
    });

    await overlay.applyMutations([
      {
        op: "create",
        schema: "app",
        table: "posts",
        externalId: "post-1",
        versionstamp: "vs2",
        values: { title: "Hello", authorId: "user-1" },
      },
      {
        op: "create",
        schema: "app",
        table: "posts",
        externalId: "post-2",
        versionstamp: "vs2",
        values: { title: "Hi", authorId: "user-2" },
      },
    ]);

    const posts = await query.find("posts", (b) =>
      b
        .whereIndex("primary")
        .join((j) =>
          j["author"]((jb) =>
            jb.whereIndex("primary", (eb) =>
              (eb as unknown as (col: string, op: "=", value: unknown) => boolean)(
                "id",
                "=",
                FragnoId.fromExternal("user-1", 1),
              ),
            ),
          ),
        ),
    );

    const adaPost = posts.find((post) => {
      const id = (post as Record<string, unknown>)["id"] as
        | { externalId?: string }
        | null
        | undefined;
      return id?.externalId === "post-1";
    });
    const gracePost = posts.find((post) => {
      const id = (post as Record<string, unknown>)["id"] as
        | { externalId?: string }
        | null
        | undefined;
      return id?.externalId === "post-2";
    });

    const adaAuthor = adaPost
      ? ((adaPost as Record<string, unknown>)["author"] as
          | Record<string, unknown>
          | null
          | undefined)
      : undefined;
    const graceAuthor = gracePost
      ? ((gracePost as Record<string, unknown>)["author"] as
          | Record<string, unknown>
          | null
          | undefined)
      : undefined;

    expect(adaAuthor?.["name"]).toBe("Ada");
    expect(graceAuthor ?? null).toBeNull();
  });

  it("removes one-to-one joins when overlay tombstones target rows", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("authorId", referenceColumn())
            .addColumn("title", column("string")),
        )
        .addReference("author", {
          type: "one",
          from: { table: "posts", column: "authorId" },
          to: { table: "users", column: "id" },
        }),
    );

    const { base, overlay, query } = createStackedQuery(appSchema);

    await base.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-vs1",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada" },
        },
        {
          op: "create",
          schema: "app",
          table: "posts",
          externalId: "post-1",
          versionstamp: "vs1",
          values: { title: "Hello", authorId: "user-1" },
        },
      ],
    });

    await overlay.applyMutations([
      {
        op: "delete",
        schema: "app",
        table: "users",
        externalId: "user-1",
        versionstamp: "vs2",
      },
    ]);

    const posts = await query.find("posts", (b) =>
      b.whereIndex("primary").join((j) => j["author"]()),
    );

    const author = (posts[0] as Record<string, unknown>)["author"] as unknown;
    expect(author ?? null).toBeNull();
  });

  it("removes tombstoned nested join rows", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("authorId", referenceColumn())
            .addColumn("title", column("string")),
        )
        .addTable("comments", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("postId", referenceColumn())
            .addColumn("body", column("string")),
        )
        .addReference("posts", {
          type: "many",
          from: { table: "users", column: "id" },
          to: { table: "posts", column: "authorId" },
        })
        .addReference("comments", {
          type: "many",
          from: { table: "posts", column: "id" },
          to: { table: "comments", column: "postId" },
        }),
    );

    const base = createStubBaseAdapter({
      users: [
        {
          id: "user-1",
          name: "Ada",
          posts: [
            {
              id: "post-1",
              title: "Hello",
              authorId: "user-1",
              comments: [{ id: "comment-1", body: "First", postId: "post-1" }],
            },
          ],
        },
      ],
    });
    const overlay = new InMemoryLofiAdapter({ endpointName: "app", schemas: [appSchema] });
    const query = createStackedQueryEngine({ schema: appSchema, base, overlay });

    await overlay.applyMutations([
      {
        op: "delete",
        schema: "app",
        table: "comments",
        externalId: "comment-1",
        versionstamp: "vs2",
      },
    ]);

    const users = await query.find("users", (b) =>
      b.whereIndex("primary").join((j) => j["posts"]((pb) => pb.join((pj) => pj["comments"]()))),
    );

    const posts = (users[0] as Record<string, unknown>)["posts"] as Array<Record<string, unknown>>;
    const comments = posts[0]?.["comments"] as Array<Record<string, unknown>> | undefined;
    expect(comments ?? []).toHaveLength(0);
  });

  it("paginates joins with overlay-only rows", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("authorId", referenceColumn())
            .addColumn("sortKey", column("integer"))
            .addColumn("title", column("string"))
            .createIndex("idx_sort", ["sortKey"]),
        )
        .addReference("author", {
          type: "one",
          from: { table: "posts", column: "authorId" },
          to: { table: "users", column: "id" },
        }),
    );

    const { base, overlay, query } = createStackedQuery(appSchema);

    await base.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-vs1",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada" },
        },
        {
          op: "create",
          schema: "app",
          table: "posts",
          externalId: "post-1",
          versionstamp: "vs1",
          values: { title: "Hello", sortKey: 1, authorId: "user-1" },
        },
        {
          op: "create",
          schema: "app",
          table: "posts",
          externalId: "post-2",
          versionstamp: "vs1",
          values: { title: "Hi", sortKey: 2, authorId: "user-1" },
        },
      ],
    });

    await overlay.applyMutations([
      {
        op: "create",
        schema: "app",
        table: "posts",
        externalId: "post-3",
        versionstamp: "vs2",
        values: { title: "Yo", sortKey: 3, authorId: "user-1" },
      },
    ]);

    const firstPage = await query.findWithCursor("posts", (b) =>
      b
        .whereIndex("idx_sort")
        .orderByIndex("idx_sort", "asc")
        .pageSize(2)
        .join((j) => j["author"]()),
    );

    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.hasNextPage).toBe(true);

    const secondPage = await query.findWithCursor("posts", (b) =>
      b
        .whereIndex("idx_sort")
        .orderByIndex("idx_sort", "asc")
        .pageSize(2)
        .after(firstPage.cursor!)
        .join((j) => j["author"]()),
    );

    expect(secondPage.items).toHaveLength(1);
    const author = (secondPage.items[0] as Record<string, unknown>)["author"] as
      | Record<string, unknown>
      | null
      | undefined;
    expect(author?.["name"]).toBe("Ada");
  });

  it("does not match composite joins with nulls or partial mismatches", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("orgId", referenceColumn())
            .addColumn("email", column("string")),
        )
        .addTable("memberships", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("orgId", referenceColumn())
            .addColumn("userEmail", column("string").nullable())
            .createIndex("idx_membership_org_email", ["orgId", "userEmail"]),
        )
        .addReference("member", {
          type: "one",
          from: { table: "memberships", column: "orgId" },
          to: { table: "users", column: "orgId" },
        }),
    );

    const relation = appSchema.tables.memberships.relations.member as {
      on: Array<[string, string]>;
    };
    relation.on.push(["userEmail", "email"]);

    const { base, overlay, query } = createStackedQuery(appSchema);

    await base.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-vs1",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { orgId: "org-1", email: "ada@example.com" },
        },
      ],
    });

    await overlay.applyMutations([
      {
        op: "create",
        schema: "app",
        table: "memberships",
        externalId: "membership-1",
        versionstamp: "vs2",
        values: { orgId: "org-1", userEmail: null },
      },
      {
        op: "create",
        schema: "app",
        table: "memberships",
        externalId: "membership-2",
        versionstamp: "vs2",
        values: { orgId: "org-1", userEmail: "missing@example.com" },
      },
    ]);

    const memberships = await query.find("memberships", (b) =>
      b.whereIndex("primary").join((j) => j["member"]()),
    );

    const first = memberships.find((row) => {
      const id = (row as Record<string, unknown>)["id"] as
        | { externalId?: string }
        | null
        | undefined;
      return id?.externalId === "membership-1";
    });
    const second = memberships.find((row) => {
      const id = (row as Record<string, unknown>)["id"] as
        | { externalId?: string }
        | null
        | undefined;
      return id?.externalId === "membership-2";
    });

    const firstMember = first
      ? ((first as Record<string, unknown>)["member"] as unknown)
      : undefined;
    const secondMember = second
      ? ((second as Record<string, unknown>)["member"] as unknown)
      : undefined;

    expect(firstMember ?? null).toBeNull();
    expect(secondMember ?? null).toBeNull();
  });

  it("orders and limits nested joins when backfilling", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("authorId", referenceColumn())
            .addColumn("title", column("string"))
            .createIndex("idx_title", ["title"]),
        )
        .addTable("comments", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("postId", referenceColumn())
            .addColumn("body", column("string"))
            .createIndex("idx_body", ["body"]),
        )
        .addReference("posts", {
          type: "many",
          from: { table: "users", column: "id" },
          to: { table: "posts", column: "authorId" },
        })
        .addReference("comments", {
          type: "many",
          from: { table: "posts", column: "id" },
          to: { table: "comments", column: "postId" },
        }),
    );

    const base = createStubBaseAdapter({
      posts: [
        { id: "post-1", title: "Alpha", authorId: "user-1" },
        { id: "post-2", title: "Gamma", authorId: "user-1" },
        { id: "post-3", title: "Beta", authorId: "user-1" },
      ],
      comments: [
        { id: "comment-1", body: "b", postId: "post-2" },
        { id: "comment-2", body: "a", postId: "post-2" },
      ],
    });
    const overlay = new InMemoryLofiAdapter({ endpointName: "app", schemas: [appSchema] });
    const query = createStackedQueryEngine({ schema: appSchema, base, overlay });

    await overlay.applyMutations([
      {
        op: "create",
        schema: "app",
        table: "users",
        externalId: "user-1",
        versionstamp: "vs2",
        values: { name: "Ada" },
      },
    ]);

    const users = await query.find("users", (b) =>
      b.whereIndex("primary").join((j) =>
        j["posts"]((pb) =>
          pb
            .orderByIndex("idx_title", "desc")
            .pageSize(1)
            .join((pj) => pj["comments"]((cb) => cb.orderByIndex("idx_body", "asc").pageSize(1))),
        ),
      ),
    );

    const posts = (users[0] as Record<string, unknown>)["posts"] as Array<Record<string, unknown>>;
    expect(posts).toHaveLength(1);
    expect(posts[0]?.["title"]).toBe("Gamma");

    const comments = posts[0]?.["comments"] as Array<Record<string, unknown>> | undefined;
    expect(comments).toHaveLength(1);
    expect(comments?.[0]?.["body"]).toBe("a");
  });
});
