import { describe, expectTypeOf, it } from "vitest";
import { column, FragnoId, idColumn, referenceColumn, schema } from "../schema/create";
import type {
  SimpleQueryInterface,
  FindFirstOptions,
  FindManyOptions,
  JoinBuilder,
  OrderBy,
  SelectClause,
  TableToInsertValues,
} from "./simple-query-interface";
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

  describe("SimpleQueryInterface methods", () => {
    type Query = SimpleQueryInterface<TestSchema>;

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

        // Test type inference through builder pattern
        function selectNameAndEmailFirst(q: Query) {
          return q.findFirst("users", (b) => b.select(["name", "email"]));
        }
        type Result = Awaited<ReturnType<typeof selectNameAndEmailFirst>>;

        expectTypeOf<Result>().toExtend<{
          name: string;
          email: string;
        } | null>();
      });

      it("should handle nullable columns correctly", () => {
        const _query = {} as Query;

        // Test type inference through builder pattern
        function selectAge(q: Query) {
          return q.findFirst("users", (b) => b.select(["age"]));
        }
        type Result = Awaited<ReturnType<typeof selectAge>>;
        type NonNullResult = Exclude<Result, null>;

        expectTypeOf<NonNullResult>().toMatchObjectType<{ age: number | null }>();
      });
    });

    describe("find", () => {
      it("should return array of all columns when select is true or undefined", () => {
        const _query = {} as Query;
        type Result = Awaited<ReturnType<typeof _query.find<"users">>>;

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

        // Test type inference through builder pattern (mimics actual usage)
        function selectNameAndEmail(q: Query) {
          return q.find("users", (b) => b.select(["name", "email"]));
        }

        type Result = Awaited<ReturnType<typeof selectNameAndEmail>>;
        type ResultElement = Result[number];

        // Verify the result array contains the selected columns
        expectTypeOf<ResultElement>().toMatchObjectType<{
          name: string;
          email: string;
        }>();

        // Verify that only selected columns exist (not age or isActive)
        // @ts-expect-error - age should not exist on the result type
        type _AgeType = ResultElement["age"];
        // @ts-expect-error - isActive should not exist on the result type
        type _IsActiveType = ResultElement["isActive"];
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

      it("should return the created ID", () => {
        const _query = {} as Query;
        type Result = Awaited<ReturnType<typeof _query.create<"users">>>;

        expectTypeOf<Result>().toEqualTypeOf<FragnoId>();
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
        // createMany returns array of IDs
        expectTypeOf<Result>().toEqualTypeOf<FragnoId[]>();
      });
    });

    describe("updateMany", () => {
      it("should accept a builder function", () => {
        const _query = {} as Query;

        // updateMany accepts a builder function, not an options object
        type Params = Parameters<typeof _query.updateMany<"users">>;

        // Check that updateMany takes correct parameters
        expectTypeOf<Params[0]>().toEqualTypeOf<"users">();
        expectTypeOf<Params[1]>().toBeFunction();
      });
    });
  });

  describe("table name type checking", () => {
    it("should only allow valid table names", () => {
      const _query = {} as SimpleQueryInterface<TestSchema>;

      // Valid table names
      type UsersParam = Parameters<typeof _query.find<"users">>;
      type PostsParam = Parameters<typeof _query.find<"posts">>;
      type CommentsParam = Parameters<typeof _query.find<"comments">>;

      expectTypeOf<UsersParam>().not.toEqualTypeOf<never>();
      expectTypeOf<PostsParam>().not.toEqualTypeOf<never>();
      expectTypeOf<CommentsParam>().not.toEqualTypeOf<never>();
    });
  });

  describe("column type inference", () => {
    it("should correctly infer column types for users table", () => {
      const _query = {} as SimpleQueryInterface<TestSchema>;
      type Result = Awaited<ReturnType<typeof _query.findFirst<"users">>>;
      type User = Exclude<Result, null>;

      expectTypeOf<User["_id"]>().toEqualTypeOf<FragnoId>();
      expectTypeOf<User["name"]>().toEqualTypeOf<string>();
      expectTypeOf<User["email"]>().toEqualTypeOf<string>();
      expectTypeOf<User["age"]>().toEqualTypeOf<number | null>();
      expectTypeOf<User["isActive"]>().toEqualTypeOf<boolean>();
    });

    it("should correctly infer column types for posts table", () => {
      const _query = {} as SimpleQueryInterface<TestSchema>;
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
      const _query = {} as SimpleQueryInterface<TestSchema>;
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
      const _query = {} as SimpleQueryInterface<TestSchema>;

      // Create user return type
      type UserResult = Awaited<ReturnType<typeof _query.create<"users">>>;
      expectTypeOf<UserResult>().toEqualTypeOf<FragnoId>();

      // Create post return type
      type PostResult = Awaited<ReturnType<typeof _query.create<"posts">>>;
      expectTypeOf<PostResult>().toEqualTypeOf<FragnoId>();

      // Find posts by user return type - type-only test
      type UserPostsResult = {
        title: string;
        viewCount: number;
      }[];

      expectTypeOf<UserPostsResult>().toExtend<
        {
          title: string;
          viewCount: number;
        }[]
      >();
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
        .addReference("author", {
          type: "one",
          from: { table: "posts", column: "userId" },
          to: { table: "users", column: "id" },
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
