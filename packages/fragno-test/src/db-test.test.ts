import { assert, describe, expect, it } from "vitest";

import { createClientBuilder } from "@fragno-dev/core/client";
import { defineRoute } from "@fragno-dev/core/route";
import { useFragno } from "@fragno-dev/core/vanilla";
import { column, idColumn, schema } from "@fragno-dev/db/schema";
import { z } from "zod";

import { defineFragment, defineRoutes, instantiate } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";

import { createFragmentTestClientConfig } from "./client-flow";
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
      .providesBaseService(({ defineService }) =>
        defineService({
          createUser: function (data: { name: string; email: string }) {
            return this.serviceTx(userSchema)
              .mutate(({ uow }) => uow.create("users", data))
              .transform(({ mutateResult }) => ({ ...data, id: mutateResult.valueOf() }))
              .build();
          },
          getUsers: function () {
            return this.serviceTx(userSchema)
              .retrieve((uow) =>
                uow.find("users", (b) => b.whereIndex("idx_users_all", (eb) => eb("id", "!=", ""))),
              )
              .transformRetrieve(([users]) => users.map((u) => ({ ...u, id: u.id.valueOf() })))
              .build();
          },
        }),
      )
      .build();

    const postFragmentDef = defineFragment<{}>("post-fragment")
      .extend(withDatabase(postSchema))
      .providesBaseService(({ defineService }) =>
        defineService({
          createPost: function (data: { title: string; userId: string }) {
            return this.serviceTx(postSchema)
              .mutate(({ uow }) => uow.create("posts", data))
              .transform(({ mutateResult }) => ({ ...data, id: mutateResult.valueOf() }))
              .build();
          },
          getPosts: function () {
            return this.serviceTx(postSchema)
              .retrieve((uow) =>
                uow.find("posts", (b) => b.whereIndex("idx_posts_all", (eb) => eb("id", "!=", ""))),
              )
              .transformRetrieve(([posts]) => posts.map((p) => ({ ...p, id: p.id.valueOf() })))
              .build();
          },
        }),
      )
      .build();

    // Build test setup with new builder API
    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment("user", instantiate(userFragmentDef).withConfig({}).withRoutes([]))
      .withFragment("post", instantiate(postFragmentDef).withConfig({}).withRoutes([]))
      .build();

    // Test user fragment
    const user = await fragments.user.fragment.callServices(() =>
      fragments.user.services.createUser({
        name: "Test User",
        email: "test@example.com",
      }),
    );

    expect(user).toMatchObject({
      id: expect.any(String),
      name: "Test User",
      email: "test@example.com",
    });

    // Test post fragment
    const post = await fragments.post.fragment.callServices(() =>
      fragments.post.services.createPost({
        title: "Test Post",
        userId: user.id,
      }),
    );

    expect(post).toMatchObject({
      id: expect.any(String),
      title: "Test Post",
      userId: user.id,
    });

    // Verify data exists
    const users = await fragments.user.fragment.callServices(() =>
      fragments.user.services.getUsers(),
    );
    expect(users).toHaveLength(1);

    const posts = await fragments.post.fragment.callServices(() =>
      fragments.post.services.getPosts(),
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]!.userId).toBe(user.id);

    // Cleanup
    await test.cleanup();
  });

  it("should reset database and recreate fragments", async () => {
    const userFragmentDef = defineFragment<{}>("user-fragment")
      .extend(withDatabase(userSchema))
      .providesBaseService(({ defineService }) =>
        defineService({
          createUser: function (data: { name: string; email: string }) {
            return this.serviceTx(userSchema)
              .mutate(({ uow }) => uow.create("users", data))
              .transform(({ mutateResult }) => ({ ...data, id: mutateResult.valueOf() }))
              .build();
          },
          getUsers: function () {
            return this.serviceTx(userSchema)
              .retrieve((uow) =>
                uow.find("users", (b) => b.whereIndex("idx_users_all", (eb) => eb("id", "!=", ""))),
              )
              .transformRetrieve(([users]) => users.map((u) => ({ ...u, id: u.id.valueOf() })))
              .build();
          },
        }),
      )
      .build();

    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment("user", instantiate(userFragmentDef).withConfig({}).withRoutes([]))
      .build();

    // Create a user
    await fragments.user.fragment.callServices(() =>
      fragments.user.services.createUser({
        name: "User 1",
        email: "user1@example.com",
      }),
    );

    // Verify user exists
    let users = await fragments.user.fragment.callServices(() =>
      fragments.user.services.getUsers(),
    );
    expect(users).toHaveLength(1);

    // Reset database
    await test.resetDatabase();

    // Verify database is empty
    users = await fragments.user.fragment.callServices(() => fragments.user.services.getUsers());
    expect(users).toHaveLength(0);

    // Cleanup
    await test.cleanup();
  });

  it("should allow handlerTx for direct queries", async () => {
    const userFragmentDef = defineFragment<{}>("user-fragment")
      .extend(withDatabase(userSchema))
      .providesBaseService(() => ({}))
      .build();

    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment("user", instantiate(userFragmentDef).withConfig({}).withRoutes([]))
      .build();

    // Use db directly
    const userId = await fragments.user.fragment.inContext(async function () {
      return await this.handlerTx()
        .mutate(({ forSchema }) =>
          forSchema(userSchema).create("users", {
            name: "Direct DB User",
            email: "direct@example.com",
          }),
        )
        .transform(({ mutateResult }) => mutateResult)
        .execute();
    });

    expect(userId).toBeDefined();
    expect(typeof userId.valueOf()).toBe("string");

    // Find using db
    const users = await fragments.user.fragment.inContext(async function () {
      return await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(userSchema).find("users", (b) =>
            b.whereIndex("idx_users_all", (eb) => eb("id", "=", userId)),
          ),
        )
        .transformRetrieve(([result]) => result)
        .execute();
    });

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
    expect(fragments.user.deps.databaseAdapter).toBeDefined();
    expect(fragments.user.deps.schema).toBeDefined();
    expect(fragments.user.deps.createUnitOfWork).toBeDefined();

    // Test that adapter is accessible
    expect(test.adapter).toBeDefined();

    await test.cleanup();
  });

  it("should create additional runtimes with isolated fragments on the same database", async () => {
    const userFragmentDef = defineFragment<{}>("user-fragment")
      .extend(withDatabase(userSchema))
      .withDependencies(() => ({
        state: { count: 0 },
      }))
      .providesBaseService(({ defineService }) =>
        defineService({
          createUser: function (data: { name: string; email: string }) {
            return this.serviceTx(userSchema)
              .mutate(({ uow }) => uow.create("users", data))
              .transform(({ mutateResult }) => ({ ...data, id: mutateResult.valueOf() }))
              .build();
          },
          getUsers: function () {
            return this.serviceTx(userSchema)
              .retrieve((uow) =>
                uow.find("users", (b) => b.whereIndex("idx_users_all", (eb) => eb("id", "!=", ""))),
              )
              .transformRetrieve(([users]) => users.map((u) => ({ ...u, id: u.id.valueOf() })))
              .build();
          },
        }),
      )
      .build();

    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment("user", instantiate(userFragmentDef).withConfig({}).withRoutes([]))
      .build();

    const additionalRuntime = await test.createAdditionalRuntime();

    expect(additionalRuntime.fragments.user.fragment).not.toBe(fragments.user.fragment);
    expect(additionalRuntime.fragments.user.deps).not.toBe(fragments.user.deps);
    expect(additionalRuntime.adapter).not.toBe(test.adapter);
    expect(additionalRuntime.fragments.user.deps.databaseAdapter).toBe(additionalRuntime.adapter);
    expect(fragments.user.deps.databaseAdapter).toBe(test.adapter);

    fragments.user.deps.state.count += 1;
    additionalRuntime.fragments.user.deps.state.count += 1;
    expect(fragments.user.deps.state.count).toBe(1);
    expect(additionalRuntime.fragments.user.deps.state.count).toBe(1);

    await fragments.user.fragment.callServices(() =>
      fragments.user.services.createUser({ name: "Shared DB User", email: "shared@example.com" }),
    );
    const users = await additionalRuntime.fragments.user.fragment.callServices(() =>
      additionalRuntime.fragments.user.services.getUsers(),
    );
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ name: "Shared DB User", email: "shared@example.com" });

    const originalFragment = fragments.user.fragment;
    const originalDeps = fragments.user.deps;
    const originalAdditionalFragment = additionalRuntime.fragments.user.fragment;
    const originalAdditionalDeps = additionalRuntime.fragments.user.deps;

    await test.recreateFragments();
    await additionalRuntime.recreateFragments();

    expect(fragments.user.fragment).not.toBe(originalFragment);
    expect(fragments.user.deps).not.toBe(originalDeps);
    expect(additionalRuntime.fragments.user.fragment).not.toBe(originalAdditionalFragment);
    expect(additionalRuntime.fragments.user.deps).not.toBe(originalAdditionalDeps);
    expect(fragments.user.deps.state.count).toBe(0);
    expect(additionalRuntime.fragments.user.deps.state.count).toBe(0);
    expect(fragments.user.deps.databaseAdapter).toBe(test.adapter);
    expect(additionalRuntime.fragments.user.deps.databaseAdapter).toBe(additionalRuntime.adapter);

    const usersAfterRecreate = await fragments.user.fragment.callServices(() =>
      fragments.user.services.getUsers(),
    );
    expect(usersAfterRecreate).toHaveLength(1);
    expect(usersAfterRecreate[0]).toMatchObject({
      name: "Shared DB User",
      email: "shared@example.com",
    });

    await test.cleanup();
  });

  it("should create additional runtimes with isolated fragments on the same database through clients", async () => {
    const counterFragmentDef = defineFragment<{}>("counter-client-fragment")
      .extend(withDatabase(postSchema))
      .withDependencies(() => ({
        state: { count: 0 },
      }))
      .build();

    const counterRoutes = defineRoutes(counterFragmentDef).create(({ defineRoute, deps }) => [
      defineRoute({
        method: "POST",
        path: "/increment",
        outputSchema: z.object({ count: z.number() }),
        handler: async (_input, { json }) => {
          deps.state.count += 1;
          return json({ count: deps.state.count });
        },
      }),
      defineRoute({
        method: "POST",
        path: "/decrement",
        outputSchema: z.object({ count: z.number() }),
        handler: async (_input, { json }) => {
          deps.state.count -= 1;
          return json({ count: deps.state.count });
        },
      }),
    ]);

    const createCounterClient = (config: Parameters<typeof createClientBuilder>[1]) => {
      const builder = createClientBuilder(counterFragmentDef, config, [counterRoutes]);

      return {
        useIncrement: builder.createMutator("POST", "/increment"),
        useDecrement: builder.createMutator("POST", "/decrement"),
      };
    };

    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment(
        "counter",
        instantiate(counterFragmentDef).withConfig({}).withRoutes([counterRoutes]),
      )
      .build();

    try {
      const additionalRuntime = await test.createAdditionalRuntime();
      const originalClient = useFragno(
        createCounterClient(createFragmentTestClientConfig(fragments.counter.fragment)),
      );
      const additionalClient = useFragno(
        createCounterClient(
          createFragmentTestClientConfig(additionalRuntime.fragments.counter.fragment),
        ),
      );

      expect(fragments.counter.deps).not.toBe(additionalRuntime.fragments.counter.deps);
      expect(fragments.counter.deps.state.count).toBe(0);
      expect(additionalRuntime.fragments.counter.deps.state.count).toBe(0);

      await expect(originalClient.useIncrement().mutate({})).resolves.toEqual({ count: 1 });
      await expect(originalClient.useIncrement().mutate({})).resolves.toEqual({ count: 2 });
      await expect(additionalClient.useDecrement().mutate({})).resolves.toEqual({ count: -1 });
      await expect(additionalClient.useIncrement().mutate({})).resolves.toEqual({ count: 0 });
      await expect(originalClient.useDecrement().mutate({})).resolves.toEqual({ count: 1 });

      expect(fragments.counter.deps.state.count).toBe(1);
      expect(additionalRuntime.fragments.counter.deps.state.count).toBe(0);
    } finally {
      await test.cleanup();
    }
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
      .providesBaseService(({ deps, defineService }) =>
        defineService({
          getApiKey: () => deps.apiKey,
          createUser: function (data: { name: string; email: string }) {
            return this.serviceTx(userSchema)
              .mutate(({ uow }) => uow.create("users", data))
              .transform(({ mutateResult }) => ({ ...data, id: mutateResult.valueOf() }))
              .build();
          },
        }),
      )
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
    const user = await fragments.requiredConfig.fragment.callServices(() =>
      fragments.requiredConfig.services.createUser({
        name: "Config Test User",
        email: "config@example.com",
      }),
    );

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

    await expect(buildPromise).rejects.toThrow(
      /Failed to extract schema from fragment.*API key is required/s,
    );
  });
});
