import { SQLocalKysely } from "sqlocal/kysely";
import { assert, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { KyselyAdapter } from "./adapters/kysely/kysely-adapter";
import { column, idColumn, referenceColumn, schema, type FragnoId } from "./schema/create";
import { defineFragment, instantiate } from "@fragno-dev/core";
import { defineRoutes } from "@fragno-dev/core/route";
import { withDatabase } from "./with-database";
import type { FragnoPublicConfigWithDatabase } from "./db-fragment-definition-builder";
import { ConcurrencyConflictError, type TxResult } from "./query/unit-of-work/execute-unit-of-work";
import { SQLocalDriverConfig } from "./adapters/generic-sql/driver-config";

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

  // Define Users Fragment using the new unified serviceTx API
  const usersFragmentDef = defineFragment("users-fragment")
    .extend(withDatabase(usersSchema, "users"))
    .providesService("userService", ({ defineService }) => {
      return defineService({
        // Creates a user - returns TxResult<FragnoId>
        createUser(name: string, email: string) {
          return this.serviceTx(usersSchema, {
            mutate: ({ uow }) => {
              return uow.create("users", { name, email });
            },
          });
        },
        // Gets a user by ID - returns TxResult<User | null>
        getUserById(userId: FragnoId | string) {
          return this.serviceTx(usersSchema, {
            retrieve: (uow) => {
              return uow.find("users", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", userId)),
              );
            },
            retrieveSuccess: ([users]): { id: FragnoId; name: string; email: string } | null =>
              users[0] ?? null,
          });
        },
        // Creates a profile - returns TxResult<FragnoId>
        createProfile(userId: FragnoId | string, bio: string) {
          return this.serviceTx(usersSchema, {
            mutate: ({ uow }) => {
              return uow.create("profiles", {
                user_id: userId,
                bio,
              });
            },
          });
        },
      });
    })
    .build();

  // Define routes for Users Fragment using new handlerTx API
  const usersRoutes = defineRoutes(usersFragmentDef).create(({ defineRoute }) => [
    defineRoute({
      method: "POST",
      path: "/users",
      outputSchema: z.object({ userId: z.string(), profileId: z.string() }),
      handler: async function (_input, { json }) {
        // Use handlerTx with mutate to create both user and profile atomically
        const result = await this.handlerTx({
          mutate: ({ forSchema }) => {
            const uow = forSchema(usersSchema);
            const userId = uow.create("users", { name: "John Doe", email: "john@example.com" });
            const profileId = uow.create("profiles", {
              user_id: userId,
              bio: "Software engineer",
            });
            return { userId, profileId };
          },
        });

        return json(
          { userId: result.userId.externalId, profileId: result.profileId.externalId },
          { status: 201 },
        );
      },
    }),
  ]);

  // User type for service dependency
  type User = { id: FragnoId; name: string; email: string };

  // Define Orders Fragment with cross-fragment service dependency using new serviceTx API
  const ordersFragmentDef = defineFragment("orders-fragment")
    .extend(withDatabase(ordersSchema, "orders"))
    .usesService<
      "userService",
      {
        // Service methods now return TxResult instead of Promise
        // TxResult<T> defaults to TxResult<T, T> (deps receive same type as final result)
        getUserById: (userId: FragnoId | string) => TxResult<User | null>;
      }
    >("userService")
    .providesService("orderService", ({ defineService, serviceDeps }) => {
      return defineService({
        createOrder(userExternalId: string, productName: string, quantity: number, total: number) {
          return this.serviceTx(ordersSchema, {
            deps: () => [serviceDeps.userService.getUserById(userExternalId)] as const,
            mutate: ({ uow, depsRetrieveResult: [user] }) => {
              if (!user) {
                throw new Error("User not found");
              }

              expect(user.id.externalId).toBe(userExternalId);

              return uow.create("orders", {
                user_external_id: userExternalId,
                product_name: productName,
                quantity,
                total,
              });
            },
          });
        },
        // Gets orders by user - returns TxResult<Order[]>
        getOrdersByUser(userExternalId: string) {
          return this.serviceTx(ordersSchema, {
            retrieve: (uow) => {
              return uow.find("orders", (b) =>
                b.whereIndex("orders_user_idx", (eb) =>
                  eb("user_external_id", "=", userExternalId),
                ),
              );
            },
            retrieveSuccess: ([orders]) => orders,
          });
        },
      });
    })
    .build();

  // Define routes for Orders Fragment using new handlerTx API
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
      handler: async function ({ input }, { json, error }) {
        const body = await input.valid();

        try {
          // Use handlerTx with deps to execute the service TxResult
          // createOrder validates that the user exists
          const result = await this.handlerTx({
            deps: () =>
              [
                services.orderService.createOrder(
                  body.userId,
                  body.productName,
                  body.quantity,
                  body.total,
                ),
              ] as const,
            success: ({ depsResult: [orderId] }) => ({ orderId }),
          });

          return json({ orderId: result.orderId.externalId }, { status: 201 });
        } catch (e) {
          if (e instanceof Error && e.message === "User not found") {
            return error({ message: "User not found", code: "USER_NOT_FOUND" }, { status: 404 });
          }
          throw e;
        }
      },
    }),
  ]);

  let adapter: KyselyAdapter;
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
    adapter = new KyselyAdapter({
      dialect,
      driverConfig: new SQLocalDriverConfig(),
    });

    // Run migrations for both schemas
    const usersPreparedMigrations = adapter.prepareMigrations(usersSchema, "users");
    await usersPreparedMigrations.execute(0, usersSchema.version, {
      updateVersionInMigration: false,
    });

    const ordersPreparedMigrations = adapter.prepareMigrations(ordersSchema, "orders");
    await ordersPreparedMigrations.execute(0, ordersSchema.version, {
      updateVersionInMigration: false,
    });

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
      // Use handlerTx with deps to execute the service TxResult
      const result = await this.handlerTx({
        deps: () => [usersFragment.services.userService.getUserById(userId)] as const,
        success: ({ depsResult: [user] }) => user,
      });
      return result;
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
  }, 500);

  it("should verify order was created with correct user reference", async () => {
    const orders = await ordersFragment.inContext(async function () {
      // Use handlerTx with deps to execute the service TxResult
      const result = await this.handlerTx({
        deps: () => [ordersFragment.services.orderService.getOrdersByUser(userId)] as const,
        success: ({ depsResult: [orders] }) => orders,
      });
      return result;
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
      const result = await this.handlerTx({
        deps: () => [ordersFragment.services.orderService.getOrdersByUser(userId)] as const,
        success: ({ depsResult: [orders] }) => orders,
      });
      return result;
    });
    const userFromOrdersContext = await usersFragment.inContext(async function () {
      const result = await this.handlerTx({
        deps: () =>
          [
            usersFragment.services.userService.getUserById(ordersByUser[0].user_external_id),
          ] as const,
        success: ({ depsResult: [user] }) => user,
      });
      return result;
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

    // Should return 404 error because user doesn't exist
    expect(invalidOrderResponse.status).toBe(404);
  });

  it("should be able to use inContext to call a service", async () => {
    const result = await usersFragment.inContext(async function () {
      // Use handlerTx with multiple deps
      return await this.handlerTx({
        deps: () =>
          [
            usersFragment.services.userService.getUserById(userId),
            ordersFragment.services.orderService.getOrdersByUser(userId),
          ] as const,
        success: ({ depsResult: [userResult, ordersResult] }) => ({
          user: userResult,
          orders: ordersResult,
        }),
      });
    });

    expect(result.user).toMatchObject({
      id: expect.objectContaining({
        externalId: userId,
      }),
    });

    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]).toMatchObject({
      id: expect.objectContaining({
        externalId: orderId,
      }),
      user_external_id: userId,
    });
  });

  it("should provide nonce and currentAttempt in the handlerTx context", async () => {
    let firstNonce: string;

    const result = await usersFragment.inContext(async function () {
      return await this.handlerTx({
        mutate: ({ forSchema, nonce, currentAttempt }) => {
          if (currentAttempt === 0) {
            firstNonce = nonce;
            // Trigger a conflict by throwing the specific conflict error
            throw new ConcurrencyConflictError();
          }

          expect(nonce).toBe(firstNonce);

          // Create something to verify the mutation works
          const newUserId = forSchema(usersSchema).create("users", {
            name: "Nonce Test User",
            email: `nonce-test-${Date.now()}@example.com`,
          });

          // Return context data
          return {
            newUserId,
            nonce,
            currentAttempt,
          };
        },
      });
    });

    // Verify nonce is a string UUID
    expect(result.nonce).toBeDefined();
    expect(typeof result.nonce).toBe("string");
    expect(result.nonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    expect(result.currentAttempt).toBe(1);

    // Verify user was created
    expect(result.newUserId).toBeDefined();
    expect(result.newUserId.externalId).toBeDefined();
  });

  describe("Unified Tx API (serviceTx/handlerTx)", () => {
    it("should use handlerTx with mutate to create records", async () => {
      const result = await usersFragment.inContext(async function () {
        return await this.handlerTx({
          mutate: ({ forSchema }) => {
            const newUserId = forSchema(usersSchema).create("users", {
              name: "Unified API User",
              email: "unified@example.com",
            });
            return { newUserId };
          },
        });
      });

      expect(result.newUserId).toBeDefined();
      expect(result.newUserId.externalId).toBeDefined();
    });

    it("should use handlerTx with retrieve callback to query data", async () => {
      const result = await usersFragment.inContext(async function () {
        return await this.handlerTx({
          retrieve: ({ forSchema }) => {
            // Query users and return the find handle
            const usersUow = forSchema(usersSchema);
            usersUow.find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId)));
            // Return marker that retrieve was called
            return ["retrieve-called"] as const;
          },
          retrieveSuccess: (retrieveResults) => {
            // retrieveResults is ["retrieve-called"] from the retrieve callback
            return { retrieved: true, marker: retrieveResults[0] };
          },
        });
      });

      expect(result.retrieved).toBe(true);
      expect(result.marker).toBe("retrieve-called");
    });

    it("should use handlerTx with mutate and success callbacks", async () => {
      const result = await usersFragment.inContext(async function () {
        return await this.handlerTx({
          mutate: ({ forSchema }) => {
            const newUserId = forSchema(usersSchema).create("users", {
              name: "Success Callback User",
              email: "success-callback@example.com",
            });
            return { newUserId, createdInMutate: true };
          },
          success: ({ mutateResult }) => {
            return {
              userId: mutateResult.newUserId,
              wasCreatedInMutate: mutateResult.createdInMutate,
              processedAt: new Date().toISOString(),
            };
          },
        });
      });

      expect(result.userId).toBeDefined();
      expect(result.wasCreatedInMutate).toBe(true);
      expect(result.processedAt).toBeDefined();
    });

    it("should use handlerTx with retrieve, mutate, and success callbacks", async () => {
      const result = await ordersFragment.inContext(async function () {
        return await this.handlerTx({
          retrieve: ({ forSchema }) => {
            // Register a retrieve operation
            forSchema(ordersSchema).find("orders", (b) =>
              b.whereIndex("orders_user_idx", (eb) => eb("user_external_id", "=", userId)),
            );
            return ["orders-queried"] as const;
          },
          retrieveSuccess: (retrieveResults) => {
            return { queriedOrders: true, marker: retrieveResults[0] };
          },
          mutate: ({ forSchema, retrieveResult }) => {
            expect(retrieveResult.queriedOrders).toBe(true);
            const orderId = forSchema(ordersSchema).create("orders", {
              user_external_id: userId,
              product_name: "Full Flow Product",
              quantity: 3,
              total: 3000,
            });
            return { orderId };
          },
          success: ({ mutateResult, retrieveResult }) => {
            return {
              orderId: mutateResult.orderId,
              hadRetrieve: retrieveResult.queriedOrders,
              completedAt: new Date().toISOString(),
            };
          },
        });
      });

      expect(result.orderId).toBeDefined();
      expect(result.hadRetrieve).toBe(true);
      expect(result.completedAt).toBeDefined();
    });
  });
});
