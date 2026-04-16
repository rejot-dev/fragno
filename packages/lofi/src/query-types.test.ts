import { describe, expectTypeOf, it } from "vitest";

import { column, FragnoId, idColumn, schema } from "@fragno-dev/db/schema";

import type { AsyncQueryFindFamily } from "./query-types";

describe("AsyncQueryFindFamily", () => {
  const testSchema = schema("_test", (s) =>
    s
      .addTable("users", (t) =>
        t
          .addColumn("_id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("email", column("string"))
          .addColumn("age", column("integer").nullable())
          .addColumn("isActive", column("bool")),
      )
      .addTable("posts", (t) =>
        t
          .addColumn("_id", idColumn())
          .addColumn("title", column("string"))
          .addColumn("content", column("string"))
          .addColumn("userId", column("string"))
          .addColumn("publishedAt", column("timestamp").nullable())
          .addColumn("viewCount", column("integer")),
      )
      .addTable("comments", (t) =>
        t
          .addColumn("_id", idColumn())
          .addColumn("postId", column("string"))
          .addColumn("authorId", column("string"))
          .addColumn("text", column("string"))
          .addColumn("likes", column("integer").nullable()),
      ),
  );

  type TestSchema = typeof testSchema;
  type Query = AsyncQueryFindFamily<TestSchema>;

  describe("findFirst", () => {
    it("returns all columns when select is omitted", () => {
      const query = {} as Query;
      type Result = Awaited<ReturnType<typeof query.findFirst<"users">>>;

      expectTypeOf<Result>().toExtend<{
        _id: FragnoId;
        name: string;
        email: string;
        age: number | null;
        isActive: boolean;
      } | null>();
    });

    it("returns selected columns only", () => {
      function selectNameAndEmailFirst(query: Query) {
        return query.findFirst("users", (b) => b.select(["name", "email"]));
      }

      type Result = Awaited<ReturnType<typeof selectNameAndEmailFirst>>;
      expectTypeOf<Result>().toExtend<{
        name: string;
        email: string;
      } | null>();
    });

    it("preserves nullable column types", () => {
      function selectAge(query: Query) {
        return query.findFirst("users", (b) => b.select(["age"]));
      }

      type Result = Awaited<ReturnType<typeof selectAge>>;
      type NonNullResult = Exclude<Result, null>;
      expectTypeOf<NonNullResult>().toMatchObjectType<{ age: number | null }>();
    });
  });

  describe("find", () => {
    it("returns arrays of full rows when select is omitted", () => {
      const query = {} as Query;
      type Result = Awaited<ReturnType<typeof query.find<"users">>>;

      expectTypeOf<Result>().toExtend<
        {
          _id: FragnoId;
          name: string;
          email: string;
          age: number | null;
          isActive: boolean;
        }[]
      >();
    });

    it("returns arrays of selected columns only", () => {
      function selectNameAndEmail(query: Query) {
        return query.find("users", (b) => b.select(["name", "email"]));
      }

      type Result = Awaited<ReturnType<typeof selectNameAndEmail>>;
      type ResultElement = Result[number];

      expectTypeOf<ResultElement>().toMatchObjectType<{
        name: string;
        email: string;
      }>();

      // @ts-expect-error age should not exist on the selected result
      type _AgeType = ResultElement["age"];
      // @ts-expect-error isActive should not exist on the selected result
      type _IsActiveType = ResultElement["isActive"];
    });
  });

  it("only allows valid table names", () => {
    const query = {} as Query;

    type UsersParam = Parameters<typeof query.find<"users">>;
    type PostsParam = Parameters<typeof query.find<"posts">>;
    type CommentsParam = Parameters<typeof query.find<"comments">>;

    expectTypeOf<UsersParam>().not.toEqualTypeOf<never>();
    expectTypeOf<PostsParam>().not.toEqualTypeOf<never>();
    expectTypeOf<CommentsParam>().not.toEqualTypeOf<never>();
  });

  it("infers column types correctly", () => {
    const query = {} as Query;
    type Result = Awaited<ReturnType<typeof query.findFirst<"posts">>>;
    type Post = Exclude<Result, null>;

    expectTypeOf<Post["_id"]>().toEqualTypeOf<FragnoId>();
    expectTypeOf<Post["title"]>().toEqualTypeOf<string>();
    expectTypeOf<Post["content"]>().toEqualTypeOf<string>();
    expectTypeOf<Post["userId"]>().toEqualTypeOf<string>();
    expectTypeOf<Post["publishedAt"]>().toEqualTypeOf<Date | null>();
    expectTypeOf<Post["viewCount"]>().toEqualTypeOf<number>();
  });
});
