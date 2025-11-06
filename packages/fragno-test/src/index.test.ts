import { describe, expect, expectTypeOf, it } from "vitest";
import { column, idColumn, schema } from "@fragno-dev/db/schema";
import { defineFragmentWithDatabase } from "@fragno-dev/db/fragment";
import { createDatabaseFragmentForTest, createDatabaseFragmentsForTest } from "./index";
import type { ExtractFragmentServices } from "@fragno-dev/core/api/route";

// Test schema with multiple versions
const testSchema = schema((s) => {
  return s
    .addTable("users", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("email", column("string"))
        .createIndex("idx_users_all", ["id"]); // Index for querying
    })
    .alterTable("users", (t) => {
      return t.addColumn("age", column("integer").nullable());
    });
});

// Test fragment definition
const testFragmentDef = defineFragmentWithDatabase<{}>("test-fragment")
  .withDatabase(testSchema)
  .providesService(({ db }) => {
    return {
      createUser: async (data: { name: string; email: string; age?: number | null }) => {
        const id = await db.create("users", data);
        return { ...data, id: id.valueOf() };
      },
      getUsers: async () => {
        const users = await db.find("users", (b) =>
          b.whereIndex("idx_users_all", (eb) => eb("id", "!=", "")),
        );
        return users.map((u) => ({ ...u, id: u.id.valueOf() }));
      },
    };
  });

describe("createDatabaseFragmentForTest", () => {
  it("should create and use a database fragment", async () => {
    const { fragment, test } = await createDatabaseFragmentForTest(
      { definition: testFragmentDef, routes: [] },
      {
        adapter: { type: "kysely-sqlite" },
      },
    );

    // Should be able to create and query users
    const user = await fragment.services.createUser({
      name: "Test User",
      email: "test@example.com",
      age: 25,
    });

    expect(user).toMatchObject({
      id: expect.any(String),
      name: "Test User",
      email: "test@example.com",
      age: 25,
    });

    const users = await fragment.services.getUsers();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject(user);

    await test.cleanup();
  });

  it("should throw error for non-database fragment", async () => {
    const nonDbFragment = {
      definition: {
        name: "non-db-fragment",
        additionalContext: {},
      },
      $requiredOptions: {},
    };

    await expect(
      createDatabaseFragmentForTest(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { definition: nonDbFragment as any, routes: [] },
        {
          adapter: { type: "kysely-sqlite" },
        },
      ),
    ).rejects.toThrow("Fragment 'non-db-fragment' does not have a database schema");
  });

  it("should reset database by truncating tables", async () => {
    const { fragment, test } = await createDatabaseFragmentForTest(
      { definition: testFragmentDef, routes: [] },
      {
        adapter: { type: "kysely-sqlite" },
      },
    );

    // Create some users
    await fragment.services.createUser({
      name: "User 1",
      email: "user1@example.com",
      age: 25,
    });

    // Verify users exist
    let users = await fragment.services.getUsers();
    expect(users).toHaveLength(1);

    // Reset the database
    await test.resetDatabase();

    // Verify database is empty
    users = await fragment.services.getUsers();
    expect(users).toHaveLength(0);

    // Cleanup
    await test.cleanup();
  });

  it("should expose db property for direct ORM queries", async () => {
    const { fragment, test } = await createDatabaseFragmentForTest(
      { definition: testFragmentDef, routes: [] },
      {
        adapter: { type: "kysely-sqlite" },
      },
    );

    // Test creating a record directly using test.db
    const userId = await fragment.db.create("users", {
      name: "Direct DB User",
      email: "direct@example.com",
      age: 28,
    });

    expect(userId).toBeDefined();
    expect(typeof userId.valueOf()).toBe("string");

    // Test finding records using test.db
    const users = await fragment.db.find("users", (b) =>
      b.whereIndex("idx_users_all", (eb) => eb("id", "=", userId)),
    );

    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      id: userId,
      name: "Direct DB User",
      email: "direct@example.com",
      age: 28,
    });

    await test.cleanup();
  });

  it("should work with multi-table schema", async () => {
    // Simplified auth schema for testing
    const authSchema = schema((s) => {
      return s
        .addTable("user", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("email", column("string"))
            .addColumn("passwordHash", column("string"))
            .createIndex("idx_user_email", ["email"]);
        })
        .addTable("session", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("userId", column("string"))
            .addColumn("expiresAt", column("timestamp"))
            .createIndex("idx_session_user", ["userId"]);
        });
    });

    const authFragmentDef = defineFragmentWithDatabase<{}>("auth-test")
      .withDatabase(authSchema)
      .providesService(({ db }) => {
        return {
          createUser: async (email: string, passwordHash: string) => {
            const id = await db.create("user", { email, passwordHash });
            return { id: id.valueOf(), email, passwordHash };
          },
          createSession: async (userId: string) => {
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + 30);
            const id = await db.create("session", { userId, expiresAt });
            return { id: id.valueOf(), userId, expiresAt };
          },
        };
      });

    const { fragment, test } = await createDatabaseFragmentForTest(
      { definition: authFragmentDef, routes: [] },
      {
        adapter: { type: "kysely-sqlite" },
      },
    );

    // Create a user
    const user = await fragment.services.createUser("test@test.com", "hashed-password");
    expect(user).toMatchObject({
      id: expect.any(String),
      email: "test@test.com",
      passwordHash: "hashed-password",
    });

    // Create a session for the user
    const session = await fragment.services.createSession(user.id);
    expect(session).toMatchObject({
      id: expect.any(String),
      userId: user.id,
      expiresAt: expect.any(Date),
    });

    await test.cleanup();
  });
});

describe("createDatabaseFragmentsForTest", () => {
  // Create two different schemas
  const userSchema = schema((s) => {
    return s.addTable("user", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("email", column("string"))
        .createIndex("idx_user_all", ["id"]);
    });
  });

  const postSchema = schema((s) => {
    return s.addTable("post", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("title", column("string"))
        .addColumn("userId", column("string"))
        .createIndex("idx_post_all", ["id"]);
    });
  });

  const userFragmentDef = defineFragmentWithDatabase<{}>("user-fragment")
    .withDatabase(userSchema)
    .providesService(({ db }) => {
      return {
        createUser: async (data: { name: string; email: string }) => {
          const id = await db.create("user", data);
          return { ...data, id: id.valueOf() };
        },
        getUsers: async () => {
          const users = await db.find("user", (b) =>
            b.whereIndex("idx_user_all", (eb) => eb("id", "!=", "")),
          );
          return users.map((u) => ({ ...u, id: u.id.valueOf() }));
        },
      };
    });

  const postFragmentDef = defineFragmentWithDatabase<{}>("post-fragment")
    .withDatabase(postSchema)
    .providesService(({ db }) => {
      return {
        createPost: async (data: { title: string; userId: string }) => {
          const id = await db.create("post", data);
          return { ...data, id: id.valueOf() };
        },
        getPosts: async () => {
          const posts = await db.find("post", (b) =>
            b.whereIndex("idx_post_all", (eb) => eb("id", "!=", "")),
          );
          return posts.map((p) => ({ ...p, id: p.id.valueOf() }));
        },
      };
    });

  const adapters = [
    { name: "Kysely SQLite", adapter: { type: "kysely-sqlite" as const } },
    { name: "Kysely PGLite", adapter: { type: "kysely-pglite" as const } },
    { name: "Drizzle PGLite", adapter: { type: "drizzle-pglite" as const } },
  ];

  for (const { name, adapter } of adapters) {
    it(`should allow multiple fragments to share the same database adapter - ${name}`, async () => {
      // Create both fragments with shared adapter using array input
      const { fragments, test } = await createDatabaseFragmentsForTest(
        [
          { definition: userFragmentDef, routes: [] },
          { definition: postFragmentDef, routes: [] },
        ],
        { adapter },
      );

      const [userFragment, postFragment] = fragments;

      // Create a user
      const user = await userFragment!.services.createUser({
        name: "John Doe",
        email: "john@example.com",
      });

      expect(user).toMatchObject({
        id: expect.any(String),
        name: "John Doe",
        email: "john@example.com",
      });

      // Create a post with the user's ID
      const post = await postFragment!.services.createPost({
        title: "My First Post",
        userId: user.id,
      });

      expect(post).toMatchObject({
        id: expect.any(String),
        title: "My First Post",
        userId: user.id,
      });

      // Verify data exists
      const users = await userFragment!.services.getUsers();
      expect(users).toHaveLength(1);

      const posts = await postFragment!.services.getPosts();
      expect(posts).toHaveLength(1);
      expect(posts[0]!.userId).toBe(user.id);

      // Cleanup (centralized - cleans up all fragments)
      await test.cleanup();
    }, 10000);
  }
});

describe("ExtractFragmentServices", () => {
  it("extracts provided services from database fragment with .providesService()", () => {
    const testSchema = schema((s) => s);

    interface ITestService {
      doSomething: (input: string) => Promise<string>;
      doSomethingElse: (input: number) => Promise<number>;
    }

    const fragment = defineFragmentWithDatabase<{}>("test-db-fragment")
      .withDatabase(testSchema)
      .providesService("test", {
        doSomething: async (input: string) => input.toUpperCase(),
        doSomethingElse: async (input: number) => input * 2,
      });

    type Services = ExtractFragmentServices<typeof fragment>;

    // Should include the provided service
    expectTypeOf<Services>().toMatchObjectType<{
      test: ITestService;
    }>();
  });

  it("merges unnamed .providesService() and named .providesService() in database fragment", () => {
    const testSchema = schema((s) => s);

    const fragment = defineFragmentWithDatabase<{}>("test-db-fragment")
      .withDatabase(testSchema)
      .providesService(() => ({
        internalService: async () => "internal",
      }))
      .providesService("externalService", () => ({
        publicMethod: async () => "public",
      }));

    type Services = ExtractFragmentServices<typeof fragment>;

    // Should include both internal services and provided services
    expectTypeOf<Services>().toMatchObjectType<{
      internalService: () => Promise<string>;
      externalService: {
        publicMethod: () => Promise<string>;
      };
    }>();
  });
});
