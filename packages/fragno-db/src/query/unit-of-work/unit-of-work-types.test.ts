import { describe, expectTypeOf, it } from "vitest";

import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import type { FragnoId, FragnoReference } from "../../schema/create";
import { QueryTreeFindBuilder, QueryTreeJoinBuilder, type ParentColumnRef } from "./query-tree";
import { JoinFindBuilder, UnitOfWork } from "./unit-of-work";

type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

type RecursivePrettify<T> = {
  [K in keyof T]: T[K] extends FragnoId
    ? FragnoId
    : T[K] extends FragnoReference
      ? FragnoReference
      : T[K] extends object
        ? RecursivePrettify<T[K]>
        : T[K];
} & {};

type InferJoinOut<T> =
  T extends JoinFindBuilder<infer _Table, infer _Select, infer JoinOut> ? JoinOut : never;

type InferJoinOutPrettify<T> = RecursivePrettify<InferJoinOut<T>>;

type InferQueryTreeOut<T> =
  T extends QueryTreeFindBuilder<infer _, infer __, infer ___, infer TJoinOut>
    ? TJoinOut
    : T extends QueryTreeJoinBuilder<infer _, infer __, infer ___, infer ____, infer TJoinOut>
      ? TJoinOut
      : never;

type InferQueryTreeOutPrettify<T> = RecursivePrettify<InferQueryTreeOut<T>>;

describe("UnitOfWork type tests", () => {
  const testSchema = schema("test", (s) => {
    return s
      .addTable("users", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("email", column("string"))
          .addColumn("age", column("integer").nullable())
          .addColumn("invitedBy", referenceColumn().nullable())
          .createIndex("idx_email", ["email"], { unique: true })
          .createIndex("idx_name", ["name"]);
      })
      .addTable("posts", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("title", column("string"))
          .addColumn("content", column("string"))
          .addColumn("userId", referenceColumn())
          .createIndex("idx_user", ["userId"])
          .createIndex("idx_title", ["title"]);
      })
      .addTable("comments", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("content", column("string"))
          .addColumn("postId", referenceColumn())
          .addColumn("authorId", referenceColumn())
          .createIndex("idx_post", ["postId"])
          .createIndex("idx_author", ["authorId"]);
      })
      .addTable("likes", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("postId", referenceColumn())
          .addColumn("userId", referenceColumn())
          .addColumn("reaction", column("string"))
          .createIndex("idx_likes_post", ["postId"])
          .createIndex("idx_likes_user", ["userId"]);
      })
      .addReference("author", {
        type: "one",
        from: { table: "posts", column: "userId" },
        to: { table: "users", column: "id" },
      })
      .addReference("inviter", {
        type: "one",
        from: { table: "users", column: "invitedBy" },
        to: { table: "users", column: "id" },
      })
      .addReference("post", {
        type: "one",
        from: { table: "comments", column: "postId" },
        to: { table: "posts", column: "id" },
      })
      .addReference("author", {
        type: "one",
        from: { table: "comments", column: "authorId" },
        to: { table: "users", column: "id" },
      })
      .addReference("posts", {
        type: "many",
        from: { table: "users", column: "id" },
        to: { table: "posts", column: "userId" },
      })
      .addReference("comments", {
        type: "many",
        from: { table: "posts", column: "id" },
        to: { table: "comments", column: "postId" },
      });
  });

  function createTestUOW() {
    const mockCompiler = {
      compileRetrievalOperation: () => null,
      compileMutationOperation: () => null,
    };
    const mockExecutor = {
      executeRetrievalPhase: async () => [],
      executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
    };
    const mockDecoder = {
      decode: () => [],
    };
    return new UnitOfWork(mockCompiler, mockExecutor, mockDecoder).forSchema(testSchema);
  }

  it("should type find without joins correctly", async () => {
    const uow = createTestUOW();

    const uow1 = uow.find("users", (b) => b.whereIndex("primary"));
    const [_userResult] = await uow1.executeRetrieve();
    type UserResult = RecursivePrettify<(typeof _userResult)[number]>;

    expectTypeOf<UserResult>().toEqualTypeOf<{
      id: FragnoId;
      name: string;
      email: string;
      age: number | null;
      invitedBy: FragnoReference | null;
    }>();
  });

  it("should type find with select clause correctly", async () => {
    const uow = createTestUOW();

    const uow1 = uow.find("users", (b) => b.whereIndex("primary").select(["id", "name"]));
    const [_userResult] = await uow1.executeRetrieve();
    type UserResult = RecursivePrettify<(typeof _userResult)[number]>;

    expectTypeOf<UserResult>().toEqualTypeOf<{
      id: FragnoId;
      name: string;
    }>();
  });

  it("should type find with joins correctly", async () => {
    const uow = createTestUOW();

    const uow1 = uow.find("users", (b) =>
      b
        .whereIndex("primary")
        .joinOne("inviter", "users", (ib) =>
          ib.onIndex("primary", (eb) => eb("id", "=", eb.parent("invitedBy"))).select(["name"]),
        ),
    );
    const [_userResult] = await uow1.executeRetrieve();
    type UserResult = RecursivePrettify<(typeof _userResult)[number]>;

    expectTypeOf<UserResult>().toEqualTypeOf<{
      id: FragnoId;
      name: string;
      email: string;
      age: number | null;
      invitedBy: FragnoReference | null;
      inviter: {
        name: string;
      } | null;
    }>();
  });

  it("join builder without join given", () => {
    const _builder = new JoinFindBuilder("users", testSchema.tables.users);
    type JoinOut = InferJoinOutPrettify<typeof _builder>;
    expectTypeOf<JoinOut>().toEqualTypeOf<{}>();
  });

  it("join builder with join given", () => {
    const builder = new JoinFindBuilder("users", testSchema.tables.users);

    /*
    join: (jb) =>           // jb is IndexedJoinBuilder, the thing with relations as key (fns)
      jb.posts((b) =>       // b is JoinFindBuilder
        b.whereIndex("primary").select(["id"])
      )
    */

    const _builderOut = builder.join((jb) => jb.inviter((ib) => ib.select(["name"])));
    type _JoinOut = InferJoinOutPrettify<typeof _builderOut>;
    //    ^?

    type _JoinOutInviter = Prettify<_JoinOut["inviter"]>;
    //     ^?

    expectTypeOf<_JoinOutInviter>().toEqualTypeOf<{
      name: string;
    } | null>();
  });

  it("join builder with 'many' relationship returns array", () => {
    const builder = new JoinFindBuilder("users", testSchema.tables.users);

    const _builderOut = builder.join((jb) => jb.posts((ib) => ib.select(["title"])));
    type _JoinOut = InferJoinOut<typeof _builderOut>;
    //    ^?

    type _JoinOutPosts = Prettify<_JoinOut["posts"]>;
    //     ^?

    expectTypeOf<_JoinOutPosts>().toEqualTypeOf<
      {
        title: string;
      }[]
    >();
  });

  it("preserves nested select narrowing in join builder", () => {
    const builder = new JoinFindBuilder("users", testSchema.tables.users);

    const _builderOut = builder.join((jb) =>
      jb.posts((pb) => pb.select(["title"]).join((jb2) => jb2.author((ab) => ab.select(["name"])))),
    );

    type JoinOut = InferJoinOutPrettify<typeof _builderOut>;
    type Post = Prettify<JoinOut["posts"][number]>;
    type PostTitle = Post["title"];
    type Author = Prettify<NonNullable<Post["author"]>>;

    expectTypeOf<PostTitle>().toEqualTypeOf<string>();
    expectTypeOf<Author>().toEqualTypeOf<{ name: string }>();
  });

  it("preserves nested select narrowing via UOW find", async () => {
    const uow = createTestUOW();

    const uow1 = uow.find("users", (b) =>
      b.whereIndex("primary").joinMany("posts", "posts", (pb) =>
        pb
          .onIndex("idx_user", (eb) => eb("userId", "=", eb.parent("id")))
          .select(["title"])
          .joinOne("author", "users", (ab) =>
            ab.onIndex("primary", (eb) => eb("id", "=", eb.parent("userId"))).select(["name"]),
          ),
      ),
    );

    const [_userResult] = await uow1.executeRetrieve();
    type User = RecursivePrettify<(typeof _userResult)[number]>;
    type Post = Prettify<User["posts"][number]>;
    type PostTitle = Post["title"];
    type Author = Prettify<NonNullable<Post["author"]>>;

    expectTypeOf<PostTitle>().toEqualTypeOf<string>();
    expectTypeOf<Author>().toEqualTypeOf<{ name: string }>();
  });

  it("should type find without joins correctly", async () => {
    const uow = createTestUOW();

    const uow1 = uow.find("users", (b) => b.whereIndex("primary"));
    const [_userResult] = await uow1.executeRetrieve();
    type UserResult = RecursivePrettify<(typeof _userResult)[number]>;

    expectTypeOf<UserResult>().toEqualTypeOf<{
      id: FragnoId;
      name: string;
      email: string;
      age: number | null;
      invitedBy: FragnoReference | null;
    }>();
  });

  it("should type find with select clause correctly", async () => {
    const uow = createTestUOW();

    const uow1 = uow.find("users", (b) => b.whereIndex("primary").select(["id", "name"]));
    const [_userResult] = await uow1.executeRetrieve();
    type UserResult = RecursivePrettify<(typeof _userResult)[number]>;

    expectTypeOf<UserResult>().toEqualTypeOf<{
      id: FragnoId;
      name: string;
    }>();
  });

  it("query-tree builder without joins gives empty join output", () => {
    const _builder = new QueryTreeFindBuilder(
      testSchema,
      "users",
      testSchema.tables.users,
    ).whereIndex("primary");
    type JoinOut = InferQueryTreeOutPrettify<typeof _builder>;

    expectTypeOf<JoinOut>().toEqualTypeOf<{}>();
  });

  it("query-tree builder joinOne returns a nullable object", () => {
    const _builder = new QueryTreeFindBuilder(testSchema, "users", testSchema.tables.users)
      .whereIndex("primary")
      .joinOne("inviter", "users", (joinedUser) =>
        joinedUser
          .onIndex("primary", (eb) => eb("id", "=", eb.parent("invitedBy")))
          .select(["name"]),
      );

    type JoinOut = InferQueryTreeOutPrettify<typeof _builder>;
    type Inviter = Prettify<JoinOut["inviter"]>;

    expectTypeOf<Inviter>().toEqualTypeOf<{ name: string } | null>();
  });

  it("query-tree builder joinMany returns an array", () => {
    const _builder = new QueryTreeFindBuilder(testSchema, "users", testSchema.tables.users)
      .whereIndex("primary")
      .joinMany("postsByUser", "posts", (posts) =>
        posts.onIndex("idx_user", (eb) => eb("userId", "=", eb.parent("id"))).select(["title"]),
      );

    type JoinOut = InferQueryTreeOutPrettify<typeof _builder>;
    type UserPost = Prettify<JoinOut["postsByUser"][number]>;

    expectTypeOf<UserPost>().toEqualTypeOf<{ title: string }>();
  });

  it("query-tree join builder preserves nested join output types", () => {
    const _builder = new QueryTreeJoinBuilder(
      testSchema,
      "posts",
      testSchema.tables.posts,
      testSchema.tables.users,
    )
      .onIndex("idx_user", (eb) => eb("userId", "=", eb.parent("id")))
      .select(["title"])
      .joinOne("author", "users", (author) =>
        author.onIndex("primary", (eb) => eb("id", "=", eb.parent("userId"))).select(["name"]),
      )
      .joinMany("likes", "likes", (likes) =>
        likes
          .onIndex("idx_likes_post", (eb) => eb("postId", "=", eb.parent("id")))
          .select(["reaction"]),
      );

    type JoinOut = InferQueryTreeOutPrettify<typeof _builder>;
    type Author = Prettify<NonNullable<JoinOut["author"]>>;
    type Like = Prettify<JoinOut["likes"][number]>;

    expectTypeOf<Author>().toEqualTypeOf<{ name: string }>();
    expectTypeOf<Like>().toEqualTypeOf<{ reaction: string }>();
  });

  it("preserves nested select narrowing via UOW find", async () => {
    const uow = createTestUOW();

    const uow1 = uow.find("users", (b) =>
      b
        .whereIndex("primary")
        .select(["id", "name"])
        .joinMany("posts", "posts", (posts) =>
          posts
            .onIndex("idx_user", (eb) => eb("userId", "=", eb.parent("id")))
            .select(["title", "id"])
            .joinMany("comments", "comments", (comments) =>
              comments
                .onIndex("idx_post", (eb) => eb("postId", "=", eb.parent("id")))
                .select(["content", "authorId"])
                .joinOne("author", "users", (author) =>
                  author
                    .onIndex("primary", (eb) => eb("id", "=", eb.parent("authorId")))
                    .select(["name"]),
                ),
            ),
        ),
    );

    const [_userResult] = await uow1.executeRetrieve();
    type User = RecursivePrettify<(typeof _userResult)[number]>;
    type Post = Prettify<User["posts"][number]>;
    type Comment = Prettify<Post["comments"][number]>;
    type Author = Prettify<NonNullable<Comment["author"]>>;

    expectTypeOf<User>().toEqualTypeOf<{
      id: FragnoId;
      name: string;
      posts: {
        id: FragnoId;
        title: string;
        comments: {
          content: string;
          authorId: FragnoReference;
          author: { name: string } | null;
        }[];
      }[];
    }>();
    expectTypeOf<Author>().toEqualTypeOf<{ name: string }>();
  });

  it("supports sibling query-tree joins via UOW find", async () => {
    const uow = createTestUOW();

    const uow1 = uow.find("posts", (b) =>
      b
        .whereIndex("primary")
        .select(["id", "title", "userId"])
        .joinOne("author", "users", (author) =>
          author
            .onIndex("primary", (eb) => eb("id", "=", eb.parent("userId")))
            .select(["name", "email"]),
        )
        .joinMany("comments", "comments", (comments) =>
          comments
            .onIndex("idx_post", (eb) => eb("postId", "=", eb.parent("id")))
            .select(["content"]),
        )
        .joinMany("likes", "likes", (likes) =>
          likes
            .onIndex("idx_likes_post", (eb) => eb("postId", "=", eb.parent("id")))
            .select(["reaction"]),
        ),
    );

    const [_postResult] = await uow1.executeRetrieve();
    type Post = RecursivePrettify<(typeof _postResult)[number]>;
    type Author = Prettify<NonNullable<Post["author"]>>;
    type Comment = Prettify<Post["comments"][number]>;
    type Like = Prettify<Post["likes"][number]>;

    expectTypeOf<Post>().toEqualTypeOf<{
      id: FragnoId;
      title: string;
      userId: FragnoReference;
      author: { name: string; email: string } | null;
      comments: { content: string }[];
      likes: { reaction: string }[];
    }>();
    expectTypeOf<Author>().toEqualTypeOf<{ name: string; email: string }>();
    expectTypeOf<Comment>().toEqualTypeOf<{ content: string }>();
    expectTypeOf<Like>().toEqualTypeOf<{ reaction: string }>();
  });

  it("appends find results to the typed retrieval tuple", async () => {
    const uow = createTestUOW();

    const uow1 = uow
      .find("users", (b) => b.whereIndex("primary").select(["id", "name"]))
      .find("posts", (b) =>
        b
          .whereIndex("primary")
          .select(["id", "title", "userId"])
          .joinOne("author", "users", (author) =>
            author.onIndex("primary", (eb) => eb("id", "=", eb.parent("userId"))).select(["name"]),
          ),
      );

    const results = await uow1.executeRetrieve();
    type User = RecursivePrettify<(typeof results)[0][number]>;
    type Post = RecursivePrettify<(typeof results)[1][number]>;

    expectTypeOf<User>().toEqualTypeOf<{ id: FragnoId; name: string }>();
    expectTypeOf<Post>().toEqualTypeOf<{
      id: FragnoId;
      title: string;
      userId: FragnoReference;
      author: { name: string } | null;
    }>();
  });

  it("restricts find whereIndex condition builders to columns of the chosen index", () => {
    new QueryTreeFindBuilder(testSchema, "users", testSchema.tables.users)
      .whereIndex("primary", (eb) => {
        type ColumnName = Parameters<typeof eb>[0];
        expectTypeOf<ColumnName>().toEqualTypeOf<"id">();
        return eb("id");
      })
      .whereIndex("idx_email", (eb) => {
        type ColumnName = Parameters<typeof eb>[0];
        expectTypeOf<ColumnName>().toEqualTypeOf<"email">();
        return eb("email", "=", "ada@example.com");
      })
      .whereIndex("idx_name", (eb) => {
        type ColumnName = Parameters<typeof eb>[0];
        expectTypeOf<ColumnName>().toEqualTypeOf<"name">();
        return eb("name", "=", "Ada");
      });
  });

  it("restricts query-tree onIndex child columns and types parent() from the direct parent", () => {
    new QueryTreeJoinBuilder(
      testSchema,
      "posts",
      testSchema.tables.posts,
      testSchema.tables.users,
    ).onIndex("idx_user", (eb) => {
      type ChildColumn = Parameters<typeof eb>[0];
      type ParentColumn = Parameters<typeof eb.parent>[0];
      type ParentIdRef = ReturnType<typeof eb.parent<"id">>;

      expectTypeOf<ChildColumn>().toEqualTypeOf<"userId">();
      expectTypeOf<ParentColumn>().toEqualTypeOf<"id" | "name" | "email" | "age" | "invitedBy">();
      expectTypeOf<ParentIdRef>().toExtend<
        ParentColumnRef<(typeof testSchema.tables.users.columns)["id"]>
      >();

      return eb.and(eb("userId", "=", eb.parent("id")), eb.not(eb.isNull("userId")));
    });
  });

  it("types query-tree child whereIndex separately from onIndex", () => {
    new QueryTreeJoinBuilder(testSchema, "users", testSchema.tables.users, testSchema.tables.posts)
      .onIndex("primary", (eb) => {
        type ChildColumn = Parameters<typeof eb>[0];
        expectTypeOf<ChildColumn>().toEqualTypeOf<"id">();
        return eb("id", "=", eb.parent("userId"));
      })
      .whereIndex("idx_name", (eb) => {
        type ChildColumn = Parameters<typeof eb>[0];
        expectTypeOf<ChildColumn>().toEqualTypeOf<"name">();
        return eb("name", "=", "Ada");
      });
  });

  it("types find and findFirst count results correctly", async () => {
    const uow = createTestUOW();

    const uow1 = uow
      .find("users", (b) => b.whereIndex("primary").selectCount())
      .findFirst("users", (b) => b.whereIndex("primary").selectCount());

    const results = await uow1.executeRetrieve();
    type CountResult = (typeof results)[0];
    type FirstCountResult = (typeof results)[1];

    expectTypeOf<CountResult>().toEqualTypeOf<number>();
    expectTypeOf<FirstCountResult>().toEqualTypeOf<number>();
  });

  it("types findFirst and findWithCursor results correctly", async () => {
    const uow = createTestUOW();

    const uow1 = uow
      .findFirst("users", (b) => b.whereIndex("primary").select(["id", "name"]))
      .findWithCursor("users", (b) =>
        b
          .whereIndex("idx_name", (eb) => eb("name", "=", "Ada"))
          .orderByIndex("idx_name", "asc")
          .pageSize(2)
          .select(["id", "name"]),
      );

    const results = await uow1.executeRetrieve();
    type FirstUser = RecursivePrettify<(typeof results)[0]>;
    type CursorPage = (typeof results)[1];
    type CursorUser = RecursivePrettify<CursorPage["items"][number]>;

    expectTypeOf<FirstUser>().toEqualTypeOf<{ id: FragnoId; name: string } | null>();
    expectTypeOf<CursorUser>().toEqualTypeOf<{ id: FragnoId; name: string }>();
  });

  it("rejects non-indexed columns in query-tree condition builders", () => {
    if (process.env["NODE_ENV"] === "__typecheck_only__") {
      new QueryTreeFindBuilder(testSchema, "users", testSchema.tables.users).whereIndex(
        "idx_email",
        (eb) => {
          // @ts-expect-error age is not part of idx_email
          eb("age", "=", 123);
          return eb("email", "=", "ada@example.com");
        },
      );

      new QueryTreeJoinBuilder(
        testSchema,
        "posts",
        testSchema.tables.posts,
        testSchema.tables.users,
      ).onIndex("idx_user", (eb) => {
        // @ts-expect-error title is not part of idx_user
        eb("title", "=", "Hello");
        return eb("userId", "=", eb.parent("id"));
      });
    }
  });
});
