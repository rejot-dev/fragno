import { Kysely } from "kysely";
import { SQLocalKysely } from "sqlocal/kysely";
import { assert, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { KyselyAdapter } from "./adapters/kysely/kysely-adapter";
import { column, idColumn, referenceColumn, schema, type FragnoId } from "./schema/create";
import { defineFragment, instantiate } from "@fragno-dev/core";
import { defineRoutes } from "@fragno-dev/core/route";
import { withDatabase } from "./db-fragment-definition-builder";
import type { FragnoPublicConfigWithDatabase } from "./db-fragment-definition-builder";

describe.sequential("Database Fragment Integration", () => {
  // Schema 1: Users fragment
  const usersSchema = schema((s) => {
    return s
      .addTable("users", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("email", column("string"))
          .createIndex("email_idx", ["email"], { unique: true });
      })
      .addTable("profiles", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("user_id", referenceColumn())
          .addColumn("bio", column("string"))
          .createIndex("profile_user_idx", ["user_id"]);
      })
      .addReference("user", {
        type: "one",
        from: { table: "profiles", column: "user_id" },
        to: { table: "users", column: "id" },
      });
  });

  // Schema 2: Orders fragment
  const ordersSchema = schema((s) => {
    return s.addTable("orders", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("user_external_id", column("string")) // Store external user ID from users fragment
        .addColumn("product_name", column("string"))
        .addColumn("quantity", column("integer"))
        .addColumn("total", column("integer"))
        .createIndex("orders_user_idx", ["user_external_id"]);
    });
  });

  // Define Users Fragment
  const usersFragmentDef = defineFragment("users-fragment")
    .extend(withDatabase(usersSchema, "users"))
    .providesService("userService", ({ defineService }) => {
      return defineService({
        createUser(name: string, email: string): FragnoId {
          const uow = this.getUnitOfWork(usersSchema);
          return uow.create("users", { name, email });
        },
        async getUserById(userId: FragnoId | string) {
          const uow = this.getUnitOfWork(usersSchema).find("users", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", userId)),
          );
          // Note: executeRetrieve() should be called by the caller before awaiting retrievalPhase
          const [users] = await uow.retrievalPhase;
          return users?.[0] ?? null;
        },
        createProfile(userId: FragnoId | string, bio: string): FragnoId {
          const uow = this.getUnitOfWork(usersSchema);
          return uow.create("profiles", {
            user_id: userId,
            bio,
          });
        },
      });
    })
    .build();

  // Define routes for Users Fragment
  const usersRoutes = defineRoutes(usersFragmentDef).create(({ services, defineRoute }) => [
    defineRoute({
      method: "POST",
      path: "/users",
      outputSchema: z.object({ userId: z.string(), profileId: z.string() }),
      handler: async function (_input, { json }) {
        const userId = services.userService.createUser("John Doe", "john@example.com");
        const profileId = services.userService.createProfile(userId, "Software engineer");

        await this.execute();

        return json(
          { userId: userId.externalId, profileId: profileId.externalId },
          { status: 201 },
        );
      },
    }),
  ]);

  // Define Orders Fragment with cross-fragment service dependency
  const ordersFragmentDef = defineFragment("orders-fragment")
    .extend(withDatabase(ordersSchema, "orders"))
    .usesService<
      "userService",
      {
        getUserById: (
          userId: FragnoId | string,
        ) => Promise<{ id: FragnoId; name: string; email: string } | null>;
      }
    >("userService")
    .providesService("orderService", ({ defineService, serviceDeps }) => {
      return defineService({
        async createOrder(
          userExternalId: string,
          productName: string,
          quantity: number,
          total: number,
        ) {
          // Verify user exists by calling the userService from the other fragment
          // Phase execution is handled by the handler, not the service
          const user = await serviceDeps.userService.getUserById(userExternalId);
          if (!user) {
            throw new Error("User not found");
          }

          const uow = this.getUnitOfWork(ordersSchema);
          return uow.create("orders", {
            user_external_id: userExternalId,
            product_name: productName,
            quantity,
            total,
          });
        },
        async getOrdersByUser(userExternalId: string) {
          const uow = this.getUnitOfWork(ordersSchema).find("orders", (b) =>
            b.whereIndex("orders_user_idx", (eb) => eb("user_external_id", "=", userExternalId)),
          );
          // Note: executeRetrieve() should be called by the caller before awaiting retrievalPhase
          const [orders] = await uow.retrievalPhase;
          return orders;
        },
      });
    })
    .build();

  // Define routes for Orders Fragment
  const ordersRoutes = defineRoutes(ordersFragmentDef).create(({ services, defineRoute }) => [
    defineRoute({
      method: "POST",
      path: "/orders",
      inputSchema: z.object({
        userId: z.string(),
        productName: z.string(),
        quantity: z.number(),
        total: z.number(),
      }),
      outputSchema: z.object({ orderId: z.string() }),
      handler: async function ({ input }, { json }) {
        const body = await input.valid();

        // Start the service call (which adds operations to UOW and awaits phases)
        const orderIdPromise = services.orderService.createOrder(
          body.userId,
          body.productName,
          body.quantity,
          body.total,
        );

        const uow = this.getUnitOfWork();
        await uow.executeRetrieve();

        // Now the service call can complete
        const orderId = await orderIdPromise;

        // Execute mutations
        await uow.executeMutations();

        return json({ orderId: orderId.externalId }, { status: 201 });
      },
    }),
  ]);

  let adapter: KyselyAdapter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let kysely: Kysely<any>;
  let usersFragment: ReturnType<typeof instantiateUsersFragment>;
  let ordersFragment: ReturnType<typeof instantiateOrdersFragment>;

  // Shared state between tests
  let userId: string;
  let orderId: string;

  function instantiateUsersFragment(options: FragnoPublicConfigWithDatabase) {
    return instantiate(usersFragmentDef)
      .withConfig({})
      .withRoutes([usersRoutes])
      .withOptions(options)
      .build();
  }

  function instantiateOrdersFragment(options: FragnoPublicConfigWithDatabase) {
    return instantiate(ordersFragmentDef)
      .withConfig({})
      .withRoutes([ordersRoutes])
      .withOptions(options)
      .withServices({
        userService: usersFragment.services.userService,
      })
      .build();
  }

  beforeAll(async () => {
    // Create in-memory SQLite database with Kysely
    const { dialect } = new SQLocalKysely(":memory:");
    kysely = new Kysely({
      dialect,
    });

    adapter = new KyselyAdapter({
      db: kysely,
      provider: "sqlite",
    });

    // Run migrations for both schemas
    const usersMigrator = adapter.createMigrationEngine(usersSchema, "users");
    const usersPrep = await usersMigrator.prepareMigration({ updateSettings: false });
    await usersPrep.execute();

    const ordersMigrator = adapter.createMigrationEngine(ordersSchema, "orders");
    const ordersPrep = await ordersMigrator.prepareMigration({ updateSettings: false });
    await ordersPrep.execute();

    // Instantiate fragments with shared database adapter
    const options: FragnoPublicConfigWithDatabase = {
      databaseAdapter: adapter,
    };

    usersFragment = instantiateUsersFragment(options);
    ordersFragment = instantiateOrdersFragment(options);
  }, 12000);

  it("should create a user via API route", async () => {
    const createUserResponse = await usersFragment.callRoute("POST", "/users");
    assert(createUserResponse.type === "json");
    expect(createUserResponse.data).toHaveProperty("userId");
    userId = createUserResponse.data.userId;
  });

  it("should verify user was created with profile", async () => {
    const user = await usersFragment.inContext(async function () {
      const userPromise = usersFragment.services.userService.getUserById(userId);
      await this.getUnitOfWork().executeRetrieve();
      return await userPromise;
    });

    expect(user).toMatchObject({
      id: expect.objectContaining({
        externalId: userId,
      }),
      name: "John Doe",
      email: "john@example.com",
    });
  });

  it("should create an order via API route with cross-fragment service call", async () => {
    const createOrderResponse = await ordersFragment.callRoute("POST", "/orders", {
      body: {
        userId: userId,
        productName: "TypeScript Book",
        quantity: 2,
        total: 4999,
      },
    });
    assert(
      createOrderResponse.type === "json",
      `createOrderResponse.type !== json: ${createOrderResponse.type}`,
    );
    orderId = createOrderResponse.data.orderId;
  });

  it("should verify order was created with correct user reference", async () => {
    const orders = await ordersFragment.inContext(async function () {
      const ordersPromise = ordersFragment.services.orderService.getOrdersByUser(userId);
      await this.getUnitOfWork().executeRetrieve();
      return await ordersPromise;
    });
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      id: expect.objectContaining({
        externalId: orderId,
      }),
      user_external_id: userId,
      product_name: "TypeScript Book",
      quantity: 2,
      total: 4999,
    });
  });

  it("should verify cross-fragment service integration works bidirectionally", async () => {
    // Orders service should be able to query users via the shared userService
    const ordersByUser = await ordersFragment.inContext(async function () {
      const ordersPromise = ordersFragment.services.orderService.getOrdersByUser(userId);
      await this.getUnitOfWork().executeRetrieve();
      return await ordersPromise;
    });
    const userFromOrdersContext = await usersFragment.inContext(async function () {
      const userPromise = usersFragment.services.userService.getUserById(
        ordersByUser[0].user_external_id,
      );
      await this.getUnitOfWork().executeRetrieve();
      return await userPromise;
    });

    expect(userFromOrdersContext).toMatchObject({
      id: expect.objectContaining({
        externalId: userId,
      }),
      name: "John Doe",
      email: "john@example.com",
    });
  });

  it("should reject order creation for non-existent user", async () => {
    const invalidOrderResponse = await ordersFragment.callRoute("POST", "/orders", {
      body: {
        userId: "non-existent-user-id",
        productName: "Invalid Order",
        quantity: 1,
        total: 100,
      },
    });

    // Should return error because user doesn't exist
    expect(invalidOrderResponse.type).toBe("error");
  });

  it("should be able to use inContext to call a service", async () => {
    const [user, order] = await usersFragment.inContext(async function () {
      // Set up both find operations first
      const userPromise = usersFragment.services.userService.getUserById(userId);
      const orderPromise = ordersFragment.services.orderService.getOrdersByUser(userId);
      // Execute all retrievals at once
      await this.getUnitOfWork().executeRetrieve();
      // Now await the results
      return await Promise.all([userPromise, orderPromise]);
    });
    expect(user).toMatchObject({
      id: expect.objectContaining({
        externalId: userId,
      }),
    });

    expect(order).toHaveLength(1);
    expect(order[0]).toMatchObject({
      id: expect.objectContaining({
        externalId: orderId,
      }),
      user_external_id: userId,
    });
  });
});
