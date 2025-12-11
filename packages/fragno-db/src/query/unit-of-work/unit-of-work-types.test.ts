import { describe, expectTypeOf, it } from "vitest";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import { JoinFindBuilder, UnitOfWork } from "./unit-of-work";
import type { FragnoId, FragnoReference } from "../../schema/create";

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

describe("UnitOfWork type tests", () => {
  const testSchema = schema((s) => {
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
    const mockDecoder = () => [];
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
      b.whereIndex("primary").join((jb) => jb.inviter((ib) => ib.select(["name"]))),
    );
    const [_userResult] = await uow1.executeRetrieve();
    type UserResult = RecursivePrettify<(typeof _userResult)[number]>;

    // @ts-expect-error assert type
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

    // FIXME: There should not be a `{}` in the type
    expectTypeOf<_JoinOutInviter>().toEqualTypeOf<{
      id: FragnoId;
      name: string;
      email: string;
      age: number | null;
      invitedBy: FragnoReference | null;
    } | null>();
  });

  it("join builder with 'many' relationship returns array", () => {
    const builder = new JoinFindBuilder("users", testSchema.tables.users);

    const _builderOut = builder.join((jb) => jb.posts((ib) => ib.select(["title"])));
    type _JoinOut = InferJoinOut<typeof _builderOut>;
    //    ^?

    type _JoinOutPosts = Prettify<_JoinOut["posts"]>;
    //     ^?

    // FIXME: There should not be a `{}` in the array
    expectTypeOf<_JoinOutPosts>().toEqualTypeOf<
      {
        id: FragnoId;
        title: string;
        content: string;
        userId: FragnoReference;
      }[]
    >();
  });
});
