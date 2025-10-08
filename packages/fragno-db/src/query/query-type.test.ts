import { describe, expectTypeOf, it } from "vitest";
import { column, FragnoId, idColumn, referenceColumn, schema } from "../schema/create";
import type {
  AbstractQuery,
  FindFirstOptions,
  FindManyOptions,
  JoinBuilder,
  OrderBy,
  SelectClause,
  TableToInsertValues,
} from "./query";
import type { ConditionBuilder } from "./condition-builder";

describe("query type tests", () => {
  // Create test schema
  const _testSchema = schema((s) => {
    return s
      .addTable("users", (t) => {
        return t
          .addColumn("_id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("email", column("string"))
          .addColumn("age", column("integer").nullable())
          .addColumn("isActive", column("bool"));
      })
      .addTable("posts", (t) => {
        return t
          .addColumn("_id", idColumn())
          .addColumn("title", column("string"))
          .addColumn("content", column("string"))
          .addColumn("userId", column("string"))
          .addColumn("publishedAt", column("timestamp").nullable())
          .addColumn("viewCount", column("integer"));
      })
      .addTable("comments", (t) => {
        return t
          .addColumn("_id", idColumn())
          .addColumn("postId", column("string"))
          .addColumn("authorId", column("string"))
          .addColumn("text", column("string"))
          .addColumn("likes", column("integer").nullable());
      });
  });

  type TestSchema = typeof _testSchema;

  describe("SelectClause", () => {
    it("should allow true for selecting all columns", () => {
      expectTypeOf<true>().toExtend<SelectClause<TestSchema["tables"]["users"]>>();
    });

    it("should allow array of column names", () => {
      expectTypeOf<["name", "email"]>().toExtend<SelectClause<TestSchema["tables"]["users"]>>();
    });

    it("should not allow invalid column names", () => {
      expectTypeOf<["invalid"]>().not.toEqualTypeOf<SelectClause<TestSchema["tables"]["users"]>>();
    });
  });

  describe("OrderBy", () => {
    it("should allow column name with direction", () => {
      expectTypeOf<["name", "asc"]>().toExtend<
        OrderBy<keyof TestSchema["tables"]["users"]["columns"]>
      >();
      expectTypeOf<["age", "desc"]>().toExtend<
        OrderBy<keyof TestSchema["tables"]["users"]["columns"]>
      >();
    });
  });

  describe("FindManyOptions", () => {
    it("should not allow offset when IsRoot is false", () => {
      type _NonRootOptions = FindManyOptions<TestSchema["tables"]["users"], true, object, false>;

      expectTypeOf<_NonRootOptions>().not.toHaveProperty("offset");
    });
  });

  describe("FindFirstOptions", () => {
    it("should omit limit from FindManyOptions", () => {
      expectTypeOf<FindFirstOptions<TestSchema["tables"]["users"]>>().not.toHaveProperty("limit");
    });

    it("should omit orderBy and offset when IsRoot is false", () => {
      type _NonRootOptions = FindFirstOptions<TestSchema["tables"]["users"], true, object, false>;

      expectTypeOf<_NonRootOptions>().not.toHaveProperty("limit");
      expectTypeOf<_NonRootOptions>().not.toHaveProperty("orderBy");
      expectTypeOf<_NonRootOptions>().not.toHaveProperty("offset");
    });
  });

  describe("AbstractQuery methods", () => {
    type Query = AbstractQuery<TestSchema>;

    describe("findFirst", () => {
      it("should return all columns when select is true or undefined", () => {
        const _query = {} as Query;
        type Result = Awaited<ReturnType<typeof _query.findFirst<"users">>>;

        expectTypeOf<Result>().toExtend<{
          _id: FragnoId;
          name: string;
          email: string;
          age: number | null;
          isActive: boolean;
        } | null>();
      });

      it("should return selected columns only", () => {
        const _query = {} as Query;

        type Result = Awaited<
          ReturnType<typeof _query.findFirst<"users", object, ["name", "email"]>>
        >;

        expectTypeOf<Result>().toExtend<{
          name: string;
          email: string;
        } | null>();
      });

      it("should handle nullable columns correctly", () => {
        const _query = {} as Query;

        type Result = Awaited<ReturnType<typeof _query.findFirst<"users", object, ["age"]>>>;
        type NonNullResult = Exclude<Result, null>;

        expectTypeOf<NonNullResult>().toMatchTypeOf<{ age: number | null }>();
      });
    });

    describe("findMany", () => {
      it("should return array of all columns when select is true or undefined", () => {
        const _query = {} as Query;
        type Result = Awaited<ReturnType<typeof _query.findMany<"users">>>;

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

      it("should return array of selected columns only", () => {
        const _query = {} as Query;

        type Result = Awaited<
          ReturnType<typeof _query.findMany<"users", object, ["name", "email"]>>
        >;

        expectTypeOf<Result>().toExtend<
          {
            name: string;
            email: string;
          }[]
        >();
      });
    });

    describe("count", () => {
      it("should return number", () => {
        const _query = {} as Query;
        type Result = Awaited<ReturnType<typeof _query.count<"users">>>;

        expectTypeOf<Result>().toEqualTypeOf<number>();
      });
    });

    describe("create", () => {
      it("should require non-nullable columns and allow omitting nullable columns", () => {
        const _query = {} as Query;

        type Params = Parameters<typeof _query.create<"users">>[1];

        // TODO: This could be better
        expectTypeOf<{
          [x: string]: unknown;
          age?: number | null | undefined;
          _id: FragnoId;
          name: string;
          email: string;
          isActive: boolean;
        }>().toExtend<Params>();
      });

      it("should return all columns including id", () => {
        const _query = {} as Query;
        type Result = Awaited<ReturnType<typeof _query.create<"users">>>;

        expectTypeOf<Result>().toExtend<{
          _id: FragnoId;
          name: string;
          email: string;
          age: number | null;
          isActive: boolean;
        }>();
      });

      it("should handle posts table correctly", () => {
        const _query = {} as Query;

        type Params = Parameters<typeof _query.create<"posts">>[1];

        expectTypeOf<{
          publishedAt?: Date | null | undefined;
          likes?: number | null | undefined;
          _id: FragnoId;
          title: string;
          content: string;
          userId: string;
          viewCount: number;
        }>().toExtend<Params>();
      });
    });

    describe("createMany", () => {
      it("should accept array of insert values", () => {
        const _query = {} as Query;

        type Params = Parameters<typeof _query.createMany<"users">>[1];

        expectTypeOf<
          {
            name: string;
            age?: number | null | undefined;
            _id: FragnoId;
            email: string;
            isActive: boolean;
          }[]
        >().toExtend<Params>();

        type Result = Awaited<ReturnType<typeof _query.createMany<"users">>>;
        expectTypeOf<Result>().toExtend<{ _id: string }[]>();
      });
    });

    describe("updateMany", () => {
      it("should not require any columns", () => {
        const _query = {} as Query;

        type SetParam = Parameters<typeof _query.updateMany<"users">>[1]["set"];

        expectTypeOf<{
          age?: number;
        }>().toExtend<SetParam>();

        expectTypeOf<{
          name?: string;
          age?: number;
        }>().toExtend<SetParam>();
      });

      it("should not allow updating id column", () => {
        const _query = {} as Query;

        type SetParam = Parameters<typeof _query.updateMany<"users">>[1]["set"];

        expectTypeOf<{
          _id: FragnoId;
          name: string;
        }>().not.toExtend<SetParam>();
      });

      it("should allow updating nullable columns to null", () => {
        const _query = {} as Query;

        type SetParam = Parameters<typeof _query.updateMany<"users">>[1]["set"];

        expectTypeOf<{
          age: null;
        }>().toExtend<SetParam>();
      });

      it("should allow partial updates", () => {
        const _query = {} as Query;

        type SetParam = Parameters<typeof _query.updateMany<"users">>[1]["set"];

        expectTypeOf<{
          isActive: boolean;
        }>().toExtend<SetParam>();
      });
    });
  });

  describe("table name type checking", () => {
    it("should only allow valid table names", () => {
      const _query = {} as AbstractQuery<TestSchema>;

      // Valid table names
      type UsersParam = Parameters<typeof _query.findMany<"users">>;
      type PostsParam = Parameters<typeof _query.findMany<"posts">>;
      type CommentsParam = Parameters<typeof _query.findMany<"comments">>;

      expectTypeOf<UsersParam>().not.toEqualTypeOf<never>();
      expectTypeOf<PostsParam>().not.toEqualTypeOf<never>();
      expectTypeOf<CommentsParam>().not.toEqualTypeOf<never>();
    });
  });

  describe("column type inference", () => {
    it("should correctly infer column types for users table", () => {
      const _query = {} as AbstractQuery<TestSchema>;
      type Result = Awaited<ReturnType<typeof _query.findFirst<"users">>>;
      type User = Exclude<Result, null>;

      expectTypeOf<User["_id"]>().toEqualTypeOf<FragnoId>();
      expectTypeOf<User["name"]>().toEqualTypeOf<string>();
      expectTypeOf<User["email"]>().toEqualTypeOf<string>();
      expectTypeOf<User["age"]>().toEqualTypeOf<number | null>();
      expectTypeOf<User["isActive"]>().toEqualTypeOf<boolean>();
    });

    it("should correctly infer column types for posts table", () => {
      const _query = {} as AbstractQuery<TestSchema>;
      type Result = Awaited<ReturnType<typeof _query.findFirst<"posts">>>;
      type Post = Exclude<Result, null>;

      expectTypeOf<Post["_id"]>().toEqualTypeOf<FragnoId>();
      expectTypeOf<Post["title"]>().toEqualTypeOf<string>();
      expectTypeOf<Post["content"]>().toEqualTypeOf<string>();
      expectTypeOf<Post["userId"]>().toEqualTypeOf<string>();
      expectTypeOf<Post["publishedAt"]>().toEqualTypeOf<Date | null>();
      expectTypeOf<Post["viewCount"]>().toEqualTypeOf<number>();
    });

    it("should correctly infer column types for comments table", () => {
      const _query = {} as AbstractQuery<TestSchema>;
      type Result = Awaited<ReturnType<typeof _query.findFirst<"comments">>>;
      type Comment = Exclude<Result, null>;

      expectTypeOf<Comment["_id"]>().toEqualTypeOf<FragnoId>();
      expectTypeOf<Comment["postId"]>().toEqualTypeOf<string>();
      expectTypeOf<Comment["authorId"]>().toEqualTypeOf<string>();
      expectTypeOf<Comment["text"]>().toEqualTypeOf<string>();
      expectTypeOf<Comment["likes"]>().toEqualTypeOf<number | null>();
    });
  });

  describe("complex scenarios", () => {
    it("should handle multiple table operations with correct types", () => {
      const _query = {} as AbstractQuery<TestSchema>;

      // Create user return type
      type UserResult = Awaited<ReturnType<typeof _query.create<"users">>>;
      expectTypeOf<UserResult["_id"]>().toEqualTypeOf<FragnoId>();

      // Create post return type
      type PostResult = Awaited<ReturnType<typeof _query.create<"posts">>>;
      expectTypeOf<PostResult["_id"]>().toEqualTypeOf<FragnoId>();

      // Find posts by user return type
      type UserPostsResult = Awaited<
        ReturnType<typeof _query.findMany<"posts", object, ["title", "viewCount"]>>
      >;

      expectTypeOf<UserPostsResult>().toExtend<
        {
          title: string;
          viewCount: number;
        }[]
      >();
    });

    it("should handle updates with type safety", () => {
      const _query = {} as AbstractQuery<TestSchema>;

      type SetParam = Parameters<typeof _query.updateMany<"posts">>[1]["set"];

      // Valid updates
      expectTypeOf<{
        viewCount: number;
        publishedAt: Date;
      }>().toExtend<SetParam>();
    });
  });

  describe("join", () => {
    const userSchema = schema((s) => {
      return s
        .addTable("users", (t) => {
          return t.addColumn("id", idColumn()).addColumn("name", column("string"));
        })
        .addTable("posts", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("title", column("string"))
            .addColumn("userId", referenceColumn());
        })
        .addTable("tags", (t) => {
          return t.addColumn("id", idColumn()).addColumn("name", column("string"));
        })
        .addReference("posts", "author", {
          columns: ["userId"],
          targetTable: "users",
          targetColumns: ["id"],
        });
    });

    it("should handle join correctly", () => {
      const _table = userSchema.tables.posts;
      const _relations = _table.relations;

      type _Relations = typeof _table.relations;
      type Builder1 = JoinBuilder<typeof _table>;

      expectTypeOf<Builder1>().toExtend<{
        author: () => void;
      }>();
    });
  });

  describe("FragnoId support", () => {
    it("should accept FragnoId in insert values for id column", () => {
      const fragnoId = FragnoId.fromExternal("user123", 0);
      const _values: TableToInsertValues<typeof _testSchema.tables.users> = {
        _id: fragnoId,
        name: "John",
        email: "john@example.com",
        isActive: true,
      };
      // Verify the type accepts both string and FragnoId
      type IdType = TableToInsertValues<typeof _testSchema.tables.users>["_id"];
      expectTypeOf<string>().toExtend<IdType>();
      expectTypeOf<FragnoId>().toExtend<IdType>();
    });

    it("should accept string in insert values for id column", () => {
      const _values: TableToInsertValues<typeof _testSchema.tables.users> = {
        _id: "user123",
        name: "John",
        email: "john@example.com",
        isActive: true,
      };
      // Verify string is accepted
      type IdType = TableToInsertValues<typeof _testSchema.tables.users>["_id"];
      expectTypeOf<string>().toExtend<IdType>();
    });

    it("should accept FragnoId in where conditions", () => {
      const fragnoId = FragnoId.fromExternal("user123", 0);
      // This should compile without errors
      const condition = (eb: ConditionBuilder<typeof _testSchema.tables.users.columns>) =>
        eb("_id", "=", fragnoId);
      expectTypeOf(condition).toBeFunction();
    });

    it("should accept FragnoId in array where conditions", () => {
      const fragnoId1 = FragnoId.fromExternal("user123", 0);
      const fragnoId2 = FragnoId.fromExternal("user456", 0);
      // This should compile without errors
      const condition = (eb: ConditionBuilder<typeof _testSchema.tables.users.columns>) =>
        eb("_id", "in", [fragnoId1, fragnoId2, "user789"]);
      expectTypeOf(condition).toBeFunction();
    });

    it("should accept FragnoId with both external and internal IDs", () => {
      const fragnoId = new FragnoId({
        externalId: "user123",
        internalId: 1n,
        version: 1,
      });
      const _values: TableToInsertValues<typeof _testSchema.tables.posts> = {
        _id: fragnoId,
        title: "Test Post",
        content: "Content",
        userId: "user123",
        viewCount: 0,
      };
      // Verify FragnoId is accepted for id columns
      type IdType = TableToInsertValues<typeof _testSchema.tables.posts>["_id"];
      expectTypeOf<FragnoId>().toExtend<IdType>();
    });

    it("should not accept FragnoId for non-id columns", () => {
      const _values: TableToInsertValues<typeof _testSchema.tables.users> = {
        _id: "user123",
        name: "John",
        email: "john@example.com",
        isActive: true,
      };
      // This should be a type error if we try to use FragnoId for name
      type NameType = TableToInsertValues<typeof _testSchema.tables.users>["name"];
      expectTypeOf<NameType>().toExtend<string>();
      expectTypeOf<NameType>().not.toExtend<FragnoId>();
    });
  });
});
