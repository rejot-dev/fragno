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

  const findUsers = (query: Query) => query.find("users", (b) => b.whereIndex("primary"));
  const findPostsFirst = (query: Query) => query.findFirst("posts", (b) => b.whereIndex("primary"));
  const findUsersFirst = (query: Query) => query.findFirst("users", (b) => b.whereIndex("primary"));

  describe("findFirst", () => {
    it("returns all columns when select is omitted", () => {
      type Result = Awaited<ReturnType<typeof findUsersFirst>>;

      expectTypeOf<Result>().toExtend<{
        _id: FragnoId;
        name: string;
        email: string;
        age: number | null;
        isActive: boolean;
      } | null>();
    });

    it("returns selected columns only", () => {
      const selectNameAndEmailFirst = (query: Query) =>
        query.findFirst("users", (b) => b.whereIndex("primary").select(["name", "email"]));

      type Result = Awaited<ReturnType<typeof selectNameAndEmailFirst>>;
      expectTypeOf<Result>().toExtend<{
        name: string;
        email: string;
      } | null>();
    });

    it("preserves nullable column types", () => {
      const selectAge = (query: Query) =>
        query.findFirst("users", (b) => b.whereIndex("primary").select(["age"]));

      type Result = Awaited<ReturnType<typeof selectAge>>;
      type NonNullResult = Exclude<Result, null>;
      expectTypeOf<NonNullResult>().toMatchObjectType<{ age: number | null }>();
    });
  });

  describe("find", () => {
    it("returns arrays of full rows when select is omitted", () => {
      type Result = Awaited<ReturnType<typeof findUsers>>;

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
      const selectNameAndEmail = (query: Query) =>
        query.find("users", (b) => b.whereIndex("primary").select(["name", "email"]));

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

    it("returns number for selectCount", () => {
      const countUsers = (query: Query) =>
        query.find("users", (b) => b.whereIndex("primary").selectCount());

      type Result = Awaited<ReturnType<typeof countUsers>>;
      expectTypeOf<Result>().toEqualTypeOf<number>();
    });
  });

  it("only allows valid table names", () => {
    const validUsersFind = (query: Query) => query.find("users", (b) => b.whereIndex("primary"));
    const validPostsFind = (query: Query) => query.find("posts", (b) => b.whereIndex("primary"));
    const validCommentsFind = (query: Query) =>
      query.find("comments", (b) => b.whereIndex("primary"));

    expectTypeOf(validUsersFind).not.toEqualTypeOf<never>();
    expectTypeOf(validPostsFind).not.toEqualTypeOf<never>();
    expectTypeOf(validCommentsFind).not.toEqualTypeOf<never>();
  });

  it("infers column types correctly", () => {
    type Result = Awaited<ReturnType<typeof findPostsFirst>>;
    type Post = Exclude<Result, null>;

    expectTypeOf<Post["_id"]>().toEqualTypeOf<FragnoId>();
    expectTypeOf<Post["title"]>().toEqualTypeOf<string>();
    expectTypeOf<Post["content"]>().toEqualTypeOf<string>();
    expectTypeOf<Post["userId"]>().toEqualTypeOf<string>();
    expectTypeOf<Post["publishedAt"]>().toEqualTypeOf<Date | null>();
    expectTypeOf<Post["viewCount"]>().toEqualTypeOf<number>();
  });
});
