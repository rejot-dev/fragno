import { describe, expect, expectTypeOf, it } from "vitest";
import { column, idColumn, schema } from "@fragno-dev/db/schema";
import { Cursor, withDatabase } from "@fragno-dev/db";
import { defineFragment } from "@fragno-dev/core";
import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest } from "./db-test";
import type { ExtractFragmentServices } from "@fragno-dev/core/route";

// Test schema with multiple versions
const testSchema = schema("test", (s) => {
  return s
    .addTable("users", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("email", column("string"))
        .createIndex("idx_users_name", ["name"])
        .createIndex("idx_users_all", ["id"]); // Index for querying
    })
    .alterTable("users", (t) => {
      return t.addColumn("age", column("integer").nullable());
    });
});

// Test fragment definition
const testFragmentDef = defineFragment<{}>("test-fragment")
  .extend(withDatabase(testSchema))
  .providesBaseService(({ deps }) => {
    return {
      createUser: async (data: { name: string; email: string; age?: number | null }) => {
        const id = await deps.db.create("users", data);
        return { ...data, id: id.valueOf() };
      },
      getUsers: async () => {
        const users = await deps.db.find("users", (b) =>
          b.whereIndex("idx_users_all", (eb) => eb("id", "!=", "")),
        );
        return users.map((u) => ({ ...u, id: u.id.valueOf() }));
      },
      getUsersWithCursor: async (cursor?: Cursor | string) => {
        return deps.db.findWithCursor("users", (b) => {
          let builder = b
            .whereIndex("idx_users_name")
            .orderByIndex("idx_users_name", "asc")
            .pageSize(2);
          if (cursor) {
            builder = builder.after(cursor);
          }
          return builder;
        });
      },
    };
  })
  .build();

describe("buildDatabaseFragmentsTest", () => {
  it("should create and use a database fragment", async () => {
    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment("test", instantiate(testFragmentDef).withConfig({}).withRoutes([]))
      .build();

    const fragment = fragments.test;

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
    const nonDbFragmentDef = defineFragment<{}>("non-db-fragment")
      .providesBaseService(() => ({}))
      .build();

    await expect(
      buildDatabaseFragmentsTest()
        .withTestAdapter({ type: "kysely-sqlite" })
        .withFragment("nonDb", instantiate(nonDbFragmentDef).withConfig({}).withRoutes([]))
        .build(),
    ).rejects.toThrow("Fragment 'non-db-fragment' does not have a database schema");
  });

  it("should support the in-memory adapter", async () => {
    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "in-memory" })
      .withFragment("test", instantiate(testFragmentDef).withConfig({}).withRoutes([]))
      .build();

    const user = await fragments.test.services.createUser({
      name: "Memory User",
      email: "memory@example.com",
      age: 31,
    });

    expect(user).toMatchObject({
      id: expect.any(String),
      name: "Memory User",
      email: "memory@example.com",
      age: 31,
    });

    const users = await fragments.test.services.getUsers();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject(user);

    await test.cleanup();
  });

  it("should support cursor pagination with in-memory adapter", async () => {
    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "in-memory" })
      .withFragment("test", instantiate(testFragmentDef).withConfig({}).withRoutes([]))
      .build();

    const fragment = fragments.test;

    const users = [
      { name: "Alice", email: "alice@example.com" },
      { name: "Brett", email: "brett@example.com" },
      { name: "Cora", email: "cora@example.com" },
      { name: "Dylan", email: "dylan@example.com" },
      { name: "Emma", email: "emma@example.com" },
    ];

    for (const user of users) {
      await fragment.services.createUser(user);
    }

    const firstPage = await fragment.services.getUsersWithCursor();
    expect(firstPage.items.map((item) => item.name)).toEqual(["Alice", "Brett"]);
    expect(firstPage.hasNextPage).toBe(true);
    expect(firstPage.cursor).toBeDefined();

    const secondPage = await fragment.services.getUsersWithCursor(firstPage.cursor);
    expect(secondPage.items.map((item) => item.name)).toEqual(["Cora", "Dylan"]);
    expect(secondPage.hasNextPage).toBe(true);
    expect(secondPage.cursor).toBeDefined();

    const thirdPage = await fragment.services.getUsersWithCursor(secondPage.cursor);
    expect(thirdPage.items.map((item) => item.name)).toEqual(["Emma"]);
    expect(thirdPage.hasNextPage).toBe(false);
    expect(thirdPage.cursor).toBeUndefined();

    await test.cleanup();
  });

  it("should reset database by truncating tables", async () => {
    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment("test", instantiate(testFragmentDef).withConfig({}).withRoutes([]))
      .build();

    const fragment = fragments.test;

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
    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment("test", instantiate(testFragmentDef).withConfig({}).withRoutes([]))
      .build();

    const fragment = fragments.test;

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
    const authSchema = schema("auth", (s) => {
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

    const authFragmentDef = defineFragment<{}>("auth-test")
      .extend(withDatabase(authSchema))
      .providesBaseService(({ deps }) => {
        return {
          createUser: async (email: string, passwordHash: string) => {
            const id = await deps.db.create("user", { email, passwordHash });
            return { id: id.valueOf(), email, passwordHash };
          },
          createSession: async (userId: string) => {
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + 30);
            const id = await deps.db.create("session", { userId, expiresAt });
            return { id: id.valueOf(), userId, expiresAt };
          },
        };
      })
      .build();

    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment("auth", instantiate(authFragmentDef).withConfig({}).withRoutes([]))
      .build();

    const fragment = fragments.auth;

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

describe("multi-fragment tests", () => {
  // Create two different schemas
  const userSchema = schema("user", (s) => {
    return s.addTable("user", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("email", column("string"))
        .createIndex("idx_user_all", ["id"]);
    });
  });

  const postSchema = schema("post", (s) => {
    return s.addTable("post", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("title", column("string"))
        .addColumn("userId", column("string"))
        .createIndex("idx_post_all", ["id"]);
    });
  });

  const userFragmentDef = defineFragment<{}>("user-fragment")
    .extend(withDatabase(userSchema))
    .providesBaseService(({ deps }) => {
      return {
        createUser: async (data: { name: string; email: string }) => {
          const id = await deps.db.create("user", data);
          return { ...data, id: id.valueOf() };
        },
        getUsers: async () => {
          const users = await deps.db.find("user", (b) =>
            b.whereIndex("idx_user_all", (eb) => eb("id", "!=", "")),
          );
          return users.map((u) => ({ ...u, id: u.id.valueOf() }));
        },
      };
    })
    .build();

  const postFragmentDef = defineFragment<{}>("post-fragment")
    .extend(withDatabase(postSchema))
    .providesBaseService(({ deps }) => {
      return {
        createPost: async (data: { title: string; userId: string }) => {
          const id = await deps.db.create("post", data);
          return { ...data, id: id.valueOf() };
        },
        getPosts: async () => {
          const posts = await deps.db.find("post", (b) =>
            b.whereIndex("idx_post_all", (eb) => eb("id", "!=", "")),
          );
          return posts.map((p) => ({ ...p, id: p.id.valueOf() }));
        },
      };
    })
    .build();

  const adapters = [
    { name: "Kysely SQLite", adapter: { type: "kysely-sqlite" as const } },
    { name: "Kysely PGLite", adapter: { type: "kysely-pglite" as const } },
    { name: "Drizzle PGLite", adapter: { type: "drizzle-pglite" as const } },
  ];

  for (const { name, adapter } of adapters) {
    it(`should allow multiple fragments to share the same database adapter - ${name}`, async () => {
      // Create both fragments with shared adapter
      const { fragments, test } = await buildDatabaseFragmentsTest()
        .withTestAdapter(adapter)
        .withFragment("user", instantiate(userFragmentDef).withConfig({}).withRoutes([]))
        .withFragment("post", instantiate(postFragmentDef).withConfig({}).withRoutes([]))
        .build();

      // Create a user
      const user = await fragments.user.services.createUser({
        name: "John Doe",
        email: "john@example.com",
      });

      expect(user).toMatchObject({
        id: expect.any(String),
        name: "John Doe",
        email: "john@example.com",
      });

      // Create a post with the user's ID
      const post = await fragments.post.services.createPost({
        title: "My First Post",
        userId: user.id,
      });

      expect(post).toMatchObject({
        id: expect.any(String),
        title: "My First Post",
        userId: user.id,
      });

      // Verify data exists
      const users = await fragments.user.services.getUsers();
      expect(users).toHaveLength(1);

      const posts = await fragments.post.services.getPosts();
      expect(posts).toHaveLength(1);
      expect(posts[0]!.userId).toBe(user.id);

      // Cleanup (centralized - cleans up all fragments)
      await test.cleanup();
    }, 10000);
  }
});

describe("ExtractFragmentServices", () => {
  it("extracts provided services from database fragment with new API", () => {
    const testSchema = schema("test", (s) => s);

    interface ITestService {
      doSomething: (input: string) => Promise<string>;
      doSomethingElse: (input: number) => Promise<number>;
    }

    const fragment = defineFragment<{}>("test-db-fragment")
      .extend(withDatabase(testSchema))
      .providesService(
        "test",
        (): ITestService => ({
          doSomething: async (input: string) => input.toUpperCase(),
          doSomethingElse: async (input: number) => input * 2,
        }),
      )
      .build();

    type Services = ExtractFragmentServices<typeof fragment>;

    // Should include the provided service
    expectTypeOf<Services>().toMatchObjectType<{
      test: ITestService;
    }>();
  });

  it("merges base services and provided services in database fragment", () => {
    const testSchema = schema("test", (s) => s);

    const fragment = defineFragment<{}>("test-db-fragment")
      .extend(withDatabase(testSchema))
      .providesBaseService(() => ({
        internalService: async () => "internal",
      }))
      .providesService("externalService", () => ({
        publicMethod: async () => "public",
      }))
      .build();

    type Services = ExtractFragmentServices<typeof fragment>;

    // Should include both base services and provided services
    expectTypeOf<Services>().toMatchObjectType<{
      internalService: () => Promise<string>;
      externalService: {
        publicMethod: () => Promise<string>;
      };
    }>();
  });
});
