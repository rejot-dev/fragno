import { assert, describe, expect, it } from "vitest";
import { column, idColumn, schema } from "@fragno-dev/db/schema";
import { withDatabase } from "@fragno-dev/db";
import { defineFragment, instantiate } from "@fragno-dev/core";
import { defineRoute } from "@fragno-dev/core/route";
import { z } from "zod";
import { buildDatabaseFragmentsTest } from "./db-test";

// Test schema with users table
const userSchema = schema("user", (s) => {
  return s.addTable("users", (t) => {
    return t
      .addColumn("id", idColumn())
      .addColumn("name", column("string"))
      .addColumn("email", column("string"))
      .createIndex("idx_users_all", ["id"]);
  });
});

// Test schema with posts table
const postSchema = schema("post", (s) => {
  return s.addTable("posts", (t) => {
    return t
      .addColumn("id", idColumn())
      .addColumn("title", column("string"))
      .addColumn("userId", column("string"))
      .createIndex("idx_posts_all", ["id"]);
  });
});

describe("buildDatabaseFragmentsTest", () => {
  it("should create multiple fragments with shared adapter", async () => {
    // Define fragments using new API
    const userFragmentDef = defineFragment<{}>("user-fragment")
      .extend(withDatabase(userSchema))
      .providesBaseService(({ deps }) => ({
        createUser: async (data: { name: string; email: string }) => {
          const id = await deps.db.create("users", data);
          return { ...data, id: id.valueOf() };
        },
        getUsers: async () => {
          const users = await deps.db.find("users", (b) =>
            b.whereIndex("idx_users_all", (eb) => eb("id", "!=", "")),
          );
          return users.map((u) => ({ ...u, id: u.id.valueOf() }));
        },
      }))
      .build();

    const postFragmentDef = defineFragment<{}>("post-fragment")
      .extend(withDatabase(postSchema))
      .providesBaseService(({ deps }) => ({
        createPost: async (data: { title: string; userId: string }) => {
          const id = await deps.db.create("posts", data);
          return { ...data, id: id.valueOf() };
        },
        getPosts: async () => {
          const posts = await deps.db.find("posts", (b) =>
            b.whereIndex("idx_posts_all", (eb) => eb("id", "!=", "")),
          );
          return posts.map((p) => ({ ...p, id: p.id.valueOf() }));
        },
      }))
      .build();

    // Build test setup with new builder API
    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment("user", instantiate(userFragmentDef).withConfig({}).withRoutes([]))
      .withFragment("post", instantiate(postFragmentDef).withConfig({}).withRoutes([]))
      .build();

    // Test user fragment
    const user = await fragments.user.services.createUser({
      name: "Test User",
      email: "test@example.com",
    });

    expect(user).toMatchObject({
      id: expect.any(String),
      name: "Test User",
      email: "test@example.com",
    });

    // Test post fragment
    const post = await fragments.post.services.createPost({
      title: "Test Post",
      userId: user.id,
    });

    expect(post).toMatchObject({
      id: expect.any(String),
      title: "Test Post",
      userId: user.id,
    });

    // Verify data exists
    const users = await fragments.user.services.getUsers();
    expect(users).toHaveLength(1);

    const posts = await fragments.post.services.getPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.userId).toBe(user.id);

    // Cleanup
    await test.cleanup();
  });

  it("should reset database and recreate fragments", async () => {
    const userFragmentDef = defineFragment<{}>("user-fragment")
      .extend(withDatabase(userSchema))
      .providesBaseService(({ deps }) => ({
        createUser: async (data: { name: string; email: string }) => {
          const id = await deps.db.create("users", data);
          return { ...data, id: id.valueOf() };
        },
        getUsers: async () => {
          const users = await deps.db.find("users", (b) =>
            b.whereIndex("idx_users_all", (eb) => eb("id", "!=", "")),
          );
          return users.map((u) => ({ ...u, id: u.id.valueOf() }));
        },
      }))
      .build();

    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment("user", instantiate(userFragmentDef).withConfig({}).withRoutes([]))
      .build();

    // Create a user
    await fragments.user.services.createUser({
      name: "User 1",
      email: "user1@example.com",
    });

    // Verify user exists
    let users = await fragments.user.services.getUsers();
    expect(users).toHaveLength(1);

    // Reset database
    await test.resetDatabase();

    // Verify database is empty
    users = await fragments.user.services.getUsers();
    expect(users).toHaveLength(0);

    // Cleanup
    await test.cleanup();
  });

  it("should expose db for direct queries", async () => {
    const userFragmentDef = defineFragment<{}>("user-fragment")
      .extend(withDatabase(userSchema))
      .providesBaseService(() => ({}))
      .build();

    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment("user", instantiate(userFragmentDef).withConfig({}).withRoutes([]))
      .build();

    // Use db directly
    const userId = await fragments.user.db.create("users", {
      name: "Direct DB User",
      email: "direct@example.com",
    });

    expect(userId).toBeDefined();
    expect(typeof userId.valueOf()).toBe("string");

    // Find using db
    const users = await fragments.user.db.find("users", (b) =>
      b.whereIndex("idx_users_all", (eb) => eb("id", "=", userId)),
    );

    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      id: userId,
      name: "Direct DB User",
      email: "direct@example.com",
    });

    await test.cleanup();
  });

  it("should expose deps and adapter", async () => {
    const userFragmentDef = defineFragment<{}>("user-fragment")
      .extend(withDatabase(userSchema))
      .withDependencies(() => ({
        testValue: "test-dependency",
      }))
      .providesBaseService(({ deps }) => ({
        getTestValue: () => deps.testValue,
      }))
      .build();

    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment("user", instantiate(userFragmentDef).withConfig({}).withRoutes([]))
      .build();

    // Test that deps are accessible
    expect(fragments.user.deps).toBeDefined();
    expect(fragments.user.deps.testValue).toBe("test-dependency");
    expect(fragments.user.deps.db).toBeDefined();
    expect(fragments.user.deps.schema).toBeDefined();

    // Test that adapter is accessible
    expect(test.adapter).toBeDefined();
    expect(test.adapter.createQueryEngine).toBeDefined();

    await test.cleanup();
  });

  it("should support callRoute with database operations", async () => {
    // This is a simpler test that verifies callRoute exists and can be called.
    // For now, we just verify that the method exists and is callable.
    const userFragmentDef = defineFragment<{}>("user-fragment")
      .extend(withDatabase(userSchema))
      .providesBaseService(() => ({}))
      .build();

    const createUserRoute = defineRoute({
      method: "POST",
      path: "/users",
      inputSchema: z.object({
        name: z.string(),
        email: z.string(),
      }),
      outputSchema: z.object({
        id: z.string(),
        name: z.string(),
        email: z.string(),
      }),
      handler: async ({ input }, { json }) => {
        const body = await input.valid();
        return json({ ...body, id: "123" });
      },
    });

    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment(
        "user",
        instantiate(userFragmentDef).withConfig({}).withRoutes([createUserRoute]),
      )
      .build();

    const response = await fragments.user.callRoute("POST", "/users", {
      body: { name: "Test User", email: "test@example.com" },
    });

    assert(response.type === "json");
    expect(response.data).toMatchObject({
      id: "123",
      name: "Test User",
      email: "test@example.com",
    });

    await test.cleanup();
  });

  it("should use actual config during schema extraction", async () => {
    // Test that the builder uses the actual config provided via .withConfig()
    // This is important for fragments like Stripe that need API keys to initialize dependencies
    interface RequiredConfigFragmentConfig {
      apiKey: string;
      apiSecret: string;
    }

    const requiredConfigFragmentDef = defineFragment<RequiredConfigFragmentConfig>(
      "required-config-fragment",
    )
      .extend(withDatabase(userSchema))
      .withDependencies(({ config }) => {
        // This should receive the actual config, not an empty mock
        return {
          client: { key: config.apiKey, secret: config.apiSecret },
          apiKey: config.apiKey,
        };
      })
      .providesBaseService(({ deps }) => ({
        getApiKey: () => deps.apiKey,
        createUser: async (data: { name: string; email: string }) => {
          const id = await deps.db.create("users", data);
          return { ...data, id: id.valueOf() };
        },
      }))
      .build();

    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment(
        "requiredConfig",
        instantiate(requiredConfigFragmentDef)
          .withConfig({
            apiKey: "test-key",
            apiSecret: "test-secret",
          })
          .withRoutes([]),
      )
      .build();

    // Verify the fragment was created with actual config
    expect(fragments.requiredConfig.deps.apiKey).toBe("test-key");
    expect(fragments.requiredConfig.deps.client).toEqual({
      key: "test-key",
      secret: "test-secret",
    });

    // Verify database operations work
    const user = await fragments.requiredConfig.services.createUser({
      name: "Config Test User",
      email: "config@example.com",
    });

    expect(user).toMatchObject({
      id: expect.any(String),
      name: "Config Test User",
      email: "config@example.com",
    });

    await test.cleanup();
  });

  it("should provide helpful error when config is missing", async () => {
    // Test that we get a helpful error when required config is not provided
    const badFragmentDef = defineFragment<{ apiKey: string }>("bad-fragment")
      .extend(withDatabase(userSchema))
      .withDependencies(({ config }) => {
        // This will throw if apiKey is undefined
        if (!config.apiKey) {
          throw new Error("API key is required");
        }
        return {
          apiKey: config.apiKey,
        };
      })
      .providesBaseService(() => ({}))
      .build();

    // Intentionally omit the required config to test error handling
    const buildPromise = buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment("bad", instantiate(badFragmentDef).withRoutes([]))
      .build();

    await expect(buildPromise).rejects.toThrow(/Failed to extract schema from fragment/);
    await expect(buildPromise).rejects.toThrow(/API key is required/);
  });
});
