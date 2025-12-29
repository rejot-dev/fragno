import { describe, it, expect } from "vitest";
import { schema, idColumn, type FragnoId, referenceColumn } from "../../schema/create";
import {
  type UOWCompiler,
  type UOWDecoder,
  createUnitOfWork,
  type CompiledMutation,
  type UOWExecutor,
} from "./unit-of-work";
import { GenericSQLUOWOperationCompiler } from "../../adapters/generic-sql/query/generic-sql-uow-operation-compiler";
import { BetterSQLite3DriverConfig } from "../../adapters/generic-sql/driver-config";
import { createUOWCompilerFromOperationCompiler } from "../../adapters/shared/uow-operation-compiler";
import type { CompiledQuery } from "../../sql-driver/sql-driver";

// Create compiler using actual implementation
function createCompiler(): UOWCompiler<CompiledQuery> {
  const driverConfig = new BetterSQLite3DriverConfig();
  const operationCompiler = new GenericSQLUOWOperationCompiler(driverConfig);
  return createUOWCompilerFromOperationCompiler(operationCompiler);
}

// Mock executor that tracks execution and works with CompiledQuery
function createMockExecutor(): UOWExecutor<CompiledQuery, unknown> & {
  getLog: () => string[];
  clearLog: () => void;
} {
  const executionLog: string[] = [];

  return {
    executeRetrievalPhase: async (queries: CompiledQuery[]) => {
      executionLog.push(`RETRIEVAL: ${queries.length} queries`);
      // Return mock results for each query
      return queries.map(() => [{ id: "mock-id", name: "Mock User" }]);
    },
    executeMutationPhase: async (mutations: CompiledMutation<CompiledQuery>[]) => {
      executionLog.push(`MUTATION: ${mutations.length} mutations`);
      return {
        success: true,
        createdInternalIds: mutations.map(() => BigInt(Math.floor(Math.random() * 1000))),
      };
    },
    getLog: () => executionLog,
    clearLog: () => {
      executionLog.length = 0;
    },
  };
}

function createMockDecoder(): UOWDecoder {
  return {
    decode(rawResults, operations) {
      if (rawResults.length !== operations.length) {
        throw new Error("rawResults and operations must have the same length");
      }
      return rawResults;
    },
  };
}

describe("UOW Coordinator - Parent-Child Execution", () => {
  it("should allow child UOWs to add operations and parent to execute them", async () => {
    const testSchema = schema((s) =>
      s.addTable("users", (t) =>
        t.addColumn("id", idColumn()).addColumn("name", "string").addColumn("email", "string"),
      ),
    );

    const executor = createMockExecutor();
    const parentUow = createUnitOfWork(createCompiler(), executor, createMockDecoder());

    // Simulate service method 1: adds retrieval operation via child UOW
    const serviceMethod1 = () => {
      const childUow = parentUow.restrict();
      childUow.forSchema(testSchema).find("users", (b) => b.whereIndex("primary"));
    };

    // Simulate service method 2: adds mutation operation via child UOW
    const serviceMethod2 = () => {
      const childUow = parentUow.restrict();
      childUow.forSchema(testSchema).create("users", { name: "Alice", email: "alice@example.com" });
    };

    // Call both service methods
    serviceMethod1();
    serviceMethod2();

    // Parent should see both operations
    expect(parentUow.getRetrievalOperations()).toHaveLength(1);
    expect(parentUow.getMutationOperations()).toHaveLength(1);

    // Execute retrieval phase
    const results = await parentUow.executeRetrieve();
    expect(results).toHaveLength(1);

    // Execute mutation phase
    const mutationResult = await parentUow.executeMutations();
    expect(mutationResult.success).toBe(true);

    // Verify execution happened
    const log = executor.getLog();
    expect(log).toEqual(["RETRIEVAL: 1 queries", "MUTATION: 1 mutations"]);
  });

  it("should handle nested service calls that await phase promises without deadlock", async () => {
    const testSchema = schema((s) =>
      s
        .addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", "string").addColumn("email", "string"),
        )
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("userId", "string")
            .addColumn("title", "string")
            .addColumn("content", "string")
            .createIndex("idx_user", ["userId"]),
        ),
    );

    const executor = createMockExecutor();
    const parentUow = createUnitOfWork(createCompiler(), executor, createMockDecoder());

    // Service A: Get user by ID, awaits retrieval phase
    const getUserById = async (userId: string) => {
      const childUow = parentUow.restrict();
      const typedUow = childUow
        .forSchema(testSchema)
        .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId)));

      // Await retrieval phase - should not deadlock!
      const [users] = await typedUow.retrievalPhase;
      return users?.[0] ?? null;
    };

    // Service B: Get posts by user ID, awaits retrieval phase
    const getPostsByUserId = async (userId: string) => {
      const childUow = parentUow.restrict();
      const typedUow = childUow
        .forSchema(testSchema)
        .find("posts", (b) => b.whereIndex("idx_user", (eb) => eb("userId", "=", userId)));

      // Await retrieval phase - should not deadlock!
      const [posts] = await typedUow.retrievalPhase;
      return posts;
    };

    // Handler: Orchestrates multiple service calls that each await phase promises
    const handler = async () => {
      // Both services add retrieval operations and return promises that await retrievalPhase
      const userPromise = getUserById("user-123");
      const postsPromise = getPostsByUserId("user-123");

      // Execute retrieval phase - this should resolve both service promises
      await parentUow.executeRetrieve();

      // Now we can await the service results
      const user = await userPromise;
      const posts = await postsPromise;

      return { user, posts };
    };

    // Execute handler
    const result = await handler();

    // Verify results
    expect(result.user).toEqual({ id: "mock-id", name: "Mock User" });
    expect(result.posts).toEqual([{ id: "mock-id", name: "Mock User" }]);

    // Verify both retrieval operations were registered
    expect(parentUow.getRetrievalOperations()).toHaveLength(2);

    // Verify execution happened
    const log = executor.getLog();
    expect(log).toEqual(["RETRIEVAL: 2 queries"]);
  });

  it("should handle retrieval-to-mutation flow with service composition", async () => {
    const testSchema = schema((s) =>
      s
        .addTable("users", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("name", "string")
            .addColumn("email", "string")
            .addColumn("status", "string"),
        )
        .addTable("orders", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("userId", "string")
            .addColumn("total", "integer")
            .addColumn("status", "string")
            .createIndex("idx_user", ["userId"]),
        )
        .addTable("payments", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("orderId", "string")
            .addColumn("amount", "integer")
            .createIndex("idx_order", ["orderId"]),
        ),
    );

    const executor = createMockExecutor();
    const parentUow = createUnitOfWork(createCompiler(), executor, createMockDecoder());

    // Service A: Check if user exists
    const validateUser = async (userId: string) => {
      const childUow = parentUow.restrict();
      const typedUow = childUow
        .forSchema(testSchema)
        .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId)));

      const [users] = await typedUow.retrievalPhase;
      const user = users?.[0];

      if (!user) {
        throw new Error("User not found");
      }

      return user;
    };

    // Service B: Get user's pending orders
    const getPendingOrders = async (userId: string) => {
      const childUow = parentUow.restrict();
      const typedUow = childUow
        .forSchema(testSchema)
        .find("orders", (b) => b.whereIndex("idx_user", (eb) => eb("userId", "=", userId)));

      const [orders] = await typedUow.retrievalPhase;
      return orders;
    };

    // Service C: Create order and payment (uses validation results)
    const createOrderWithPayment = (userId: string, amount: number) => {
      const childUow = parentUow.restrict();
      const typedUow = childUow.forSchema(testSchema);

      // Create order
      const orderId = typedUow.create("orders", {
        userId,
        total: amount,
        status: "pending",
      });

      // Create payment for the order
      typedUow.create("payments", {
        orderId: orderId.externalId,
        amount,
      });

      // Return the ID immediately - don't await mutation phase here
      // The handler will execute the mutation phase
      return orderId;
    };

    // Handler: Orchestrates validation, retrieval, and mutations
    // Pattern: validate → retrieve data → use data to drive mutations
    const handler = async () => {
      // Phase 1: Retrieval - validate user and get existing orders
      const userPromise = validateUser("user-123");
      const ordersPromise = getPendingOrders("user-123");

      // Execute retrieval phase - resolves all service promises
      await parentUow.executeRetrieve();

      const user = await userPromise;
      const existingOrders = await ordersPromise;

      // Business logic: Only allow order if user has < 5 pending orders
      if (existingOrders.length >= 5) {
        throw new Error("Too many pending orders");
      }

      // Phase 2: Mutation - create new order based on retrieval results
      const orderId = createOrderWithPayment("user-123", 9999);

      // Execute mutation phase
      await parentUow.executeMutations();

      return { user, orderId, existingOrderCount: existingOrders.length };
    };

    // Execute handler
    const result = await handler();

    // Verify results
    expect(result.user).toEqual({ id: "mock-id", name: "Mock User" });
    expect(result.orderId.externalId).toBeTruthy();
    expect(result.existingOrderCount).toBe(1);

    // Verify operations were registered
    // 1 user validation + 1 orders query = 2 retrieval operations
    expect(parentUow.getRetrievalOperations()).toHaveLength(2);
    // 1 order create + 1 payment create = 2 mutation operations
    expect(parentUow.getMutationOperations()).toHaveLength(2);

    // Verify execution order
    const log = executor.getLog();
    expect(log).toEqual(["RETRIEVAL: 2 queries", "MUTATION: 2 mutations"]);
  });

  it("should handle deeply nested child UOWs (3+ levels)", async () => {
    const testSchema = schema((s) =>
      s
        .addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", "string").addColumn("email", "string"),
        )
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("userId", "string")
            .addColumn("title", "string")
            .createIndex("idx_user", ["userId"]),
        )
        .addTable("comments", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("postId", "string")
            .addColumn("content", "string")
            .createIndex("idx_post", ["postId"]),
        ),
    );

    const executor = createMockExecutor();
    const parentUow = createUnitOfWork(createCompiler(), executor, createMockDecoder());

    // Level 1: Handler (root)
    const handler = async () => {
      // Level 2: Service A - orchestrates user operations
      const getUserWithPosts = async (userId: string) => {
        const childUow1 = parentUow.restrict();

        // Level 3: Service B - gets just the user
        const getUser = async () => {
          const childUow2 = childUow1.restrict();
          const typedUow = childUow2
            .forSchema(testSchema)
            .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId)));

          const [users] = await typedUow.retrievalPhase;
          return users?.[0];
        };

        // Level 3: Service C - gets user's posts
        const getUserPosts = async () => {
          const childUow2 = childUow1.restrict();
          const typedUow = childUow2
            .forSchema(testSchema)
            .find("posts", (b) => b.whereIndex("idx_user", (eb) => eb("userId", "=", userId)));

          const [posts] = await typedUow.retrievalPhase;
          return posts;
        };

        // Await both nested services
        const userPromise = getUser();
        const postsPromise = getUserPosts();

        // Execute retrieval at this level - should resolve nested promises
        await parentUow.executeRetrieve();

        const user = await userPromise;
        const posts = await postsPromise;

        return { user, posts };
      };

      // Call service A and get results
      const { user, posts } = await getUserWithPosts("user-123");

      // Level 2: Service D - creates comments for the posts
      const createComment = (postId: string, content: string) => {
        const childUow1 = parentUow.restrict();

        // Level 3: Service E - validates post exists (hypothetically)
        // In real code this might query, but here we just create
        const childUow2 = childUow1.restrict();
        const typedUow2 = childUow2.forSchema(testSchema);

        typedUow2.create("comments", { postId, content });
      };

      // Create comments for each post
      if (posts && posts.length > 0) {
        for (const post of posts) {
          // Use string coercion since mock data returns string ids
          createComment(String(post.id), "Great post!");
        }
      }

      // Execute mutations
      await parentUow.executeMutations();

      return { user, postCount: posts?.length ?? 0 };
    };

    // Execute handler
    const result = await handler();

    // Verify results
    expect(result.user).toBeDefined();
    expect(result.postCount).toBe(1);

    // Verify operations were registered at root level
    // 1 user query + 1 posts query = 2 retrieval operations
    expect(parentUow.getRetrievalOperations()).toHaveLength(2);
    // 1 comment create = 1 mutation operation
    expect(parentUow.getMutationOperations()).toHaveLength(1);

    // Verify execution happened in correct order
    const log = executor.getLog();
    expect(log).toEqual(["RETRIEVAL: 2 queries", "MUTATION: 1 mutations"]);
  });

  it("should handle sibling child UOWs at same nesting level", async () => {
    const testSchema = schema((s) =>
      s
        .addTable("users", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("name", "string")
            .addColumn("email", "string")
            .createIndex("idx_email", ["email"]),
        )
        .addTable("products", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", "string").addColumn("price", "integer"),
        )
        .addTable("orders", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("userId", "string")
            .addColumn("productId", "string")
            .addColumn("quantity", "integer"),
        ),
    );

    const executor = createMockExecutor();
    const parentUow = createUnitOfWork(createCompiler(), executor, createMockDecoder());

    // Service method that creates TWO sibling child UOWs
    const processUserOrder = async (email: string) => {
      // Sibling 1: Look up user by email
      const findUserByEmail = () => {
        const childUow = parentUow.restrict();
        const typedUow = childUow
          .forSchema(testSchema)
          .find("users", (b) => b.whereIndex("idx_email", (eb) => eb("email", "=", email)));

        return typedUow.retrievalPhase.then(([users]) => users?.[0] ?? null);
      };

      // Sibling 2: Look up product by scanning (for simplicity)
      const findProductByName = () => {
        const childUow = parentUow.restrict();
        const typedUow = childUow
          .forSchema(testSchema)
          .find("products", (b) => b.whereIndex("primary"));

        return typedUow.retrievalPhase.then(([products]) => products?.[0] ?? null);
      };

      // Create both sibling UOWs at the same time
      const userPromise = findUserByEmail();
      const productPromise = findProductByName();

      // Execute retrieval - should resolve both siblings
      await parentUow.executeRetrieve();

      const user = await userPromise;
      const product = await productPromise;

      if (!user || !product) {
        throw new Error("User or product not found");
      }

      // Sibling 3: Create order using the results
      const createOrder = () => {
        const childUow = parentUow.restrict();
        const typedUow = childUow.forSchema(testSchema);

        return typedUow.create("orders", {
          userId: String(user.id),
          productId: String(product.id),
          quantity: 1,
        });
      };

      // Sibling 4: Update user (hypothetically, just another mutation)
      const updateUserEmail = () => {
        const childUow = parentUow.restrict();
        const typedUow = childUow.forSchema(testSchema);

        typedUow.update("users", user.id, (b) =>
          b.set({ email: `updated-${email}`, name: user.name }),
        );
      };

      // Execute mutations from both siblings
      createOrder();
      updateUserEmail();

      await parentUow.executeMutations();

      return { user, product };
    };

    // Execute the service
    const result = await processUserOrder("test@example.com");

    // Verify results
    expect(result.user).toBeDefined();
    expect(result.product).toBeDefined();

    // Verify operations registered from all siblings
    // Sibling 1 (user lookup) + Sibling 2 (product lookup) = 2 retrieval operations
    expect(parentUow.getRetrievalOperations()).toHaveLength(2);
    // Sibling 3 (order create) + Sibling 4 (user update) = 2 mutation operations
    expect(parentUow.getMutationOperations()).toHaveLength(2);

    // Verify execution order
    const log = executor.getLog();
    expect(log).toEqual(["RETRIEVAL: 2 queries", "MUTATION: 2 mutations"]);
  });

  it("should support transaction rollback pattern", async () => {
    const testSchema = schema((s) =>
      s
        .addTable("accounts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("userId", "string")
            .addColumn("balance", "integer")
            .createIndex("idx_user", ["userId"]),
        )
        .addTable("transactions", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("fromAccountId", referenceColumn())
            .addColumn("toAccountId", referenceColumn())
            .addColumn("amount", "integer"),
        ),
    );

    // Create mock executor that returns account data with low balance
    const executionLog: string[] = [];
    const customExecutor: UOWExecutor<CompiledQuery, unknown> = {
      executeRetrievalPhase: async (queries: CompiledQuery[]) => {
        executionLog.push(`RETRIEVAL: ${queries.length} queries`);
        // Return mock account data with balance field set to low value
        return queries.map(() => [{ id: "mock-id", userId: "user-1", balance: 100 }]);
      },
      executeMutationPhase: async (mutations: CompiledMutation<CompiledQuery>[]) => {
        executionLog.push(`MUTATION: ${mutations.length} mutations`);
        return {
          success: true,
          createdInternalIds: mutations.map(() => BigInt(Math.floor(Math.random() * 1000))),
        };
      },
    };

    const parentUow = createUnitOfWork(createCompiler(), customExecutor, createMockDecoder());

    // Service: Get account balance
    const getAccountBalance = async (userId: string) => {
      const childUow = parentUow.restrict();
      const typedUow = childUow
        .forSchema(testSchema)
        .find("accounts", (b) => b.whereIndex("idx_user", (eb) => eb("userId", "=", userId)));

      const [accounts] = await typedUow.retrievalPhase;
      return accounts?.[0] ?? null;
    };

    // Service: Create transfer (mutation)
    const createTransfer = (fromAccountId: FragnoId, toAccountId: FragnoId, amount: number) => {
      const childUow = parentUow.restrict();
      const typedUow = childUow.forSchema(testSchema);

      // Check that both accounts haven't changed since retrieval
      typedUow.check("accounts", fromAccountId);
      typedUow.check("accounts", toAccountId);

      return typedUow.create("transactions", {
        fromAccountId,
        toAccountId,
        amount,
      });
    };

    // Handler: Attempt transfer but abort if insufficient funds
    const attemptTransfer = async (fromUserId: string, toUserId: string, amount: number) => {
      // Phase 1: Retrieval - get both accounts
      const fromAccountPromise = getAccountBalance(fromUserId);
      const toAccountPromise = getAccountBalance(toUserId);

      // Execute retrieval phase
      await parentUow.executeRetrieve();

      const fromAccount = await fromAccountPromise;
      const toAccount = await toAccountPromise;

      // Validation: Check if accounts exist
      if (!fromAccount || !toAccount) {
        throw new Error("One or both accounts not found");
      }

      // Validation: Check if sufficient balance (this should fail in our test)
      if (fromAccount.balance < amount) {
        throw new Error("Insufficient funds");
      }

      // Phase 2: Mutation - would create transfer, but we never get here
      createTransfer(fromAccount.id, toAccount.id, amount);
      await parentUow.executeMutations();

      return { success: true };
    };

    // Execute handler - expect it to throw due to insufficient funds
    await expect(attemptTransfer("user-1", "user-2", 10000)).rejects.toThrow("Insufficient funds");

    // Verify retrieval phase was executed
    expect(parentUow.getRetrievalOperations()).toHaveLength(2);

    // Verify NO mutations were executed (rollback pattern)
    expect(parentUow.getMutationOperations()).toHaveLength(0);

    // Verify only retrieval phase was executed, no mutations
    expect(executionLog).toEqual(["RETRIEVAL: 2 queries"]);
  });

  it("should handle errors thrown by service methods without unhandled rejections", async () => {
    const testSchema = schema((s) =>
      s
        .addTable("users", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("name", "string")
            .addColumn("email", "string")
            .addColumn("status", "string"),
        )
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("userId", "string")
            .addColumn("title", "string")
            .createIndex("idx_user", ["userId"]),
        ),
    );

    const executor = createMockExecutor();
    const parentUow = createUnitOfWork(createCompiler(), executor, createMockDecoder());

    // Service A: Validates user and throws if not active
    const validateActiveUser = async (userId: string) => {
      const childUow = parentUow.restrict();
      const typedUow = childUow
        .forSchema(testSchema)
        .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId)));

      const [users] = await typedUow.retrievalPhase;
      const user = users?.[0];

      if (!user) {
        throw new Error("User not found");
      }

      // Mock check: assume user status is "inactive"
      if (user.name === "Mock User") {
        throw new Error("User is not active");
      }

      return user;
    };

    // Service B: Gets user posts (won't be reached due to validation error)
    const getUserPosts = async (userId: string) => {
      const childUow = parentUow.restrict();
      const typedUow = childUow
        .forSchema(testSchema)
        .find("posts", (b) => b.whereIndex("idx_user", (eb) => eb("userId", "=", userId)));

      const [posts] = await typedUow.retrievalPhase;
      return posts;
    };

    // Handler: Orchestrates service calls that may throw
    const handler = async () => {
      // Both services add retrieval operations
      const userPromise = validateActiveUser("user-123");
      const postsPromise = getUserPosts("user-123");

      // Execute retrieval phase - this resolves the retrievalPhase promises
      await parentUow.executeRetrieve();

      // Now await the service results - validateActiveUser will throw
      const user = await userPromise; // This will throw "User is not active"
      const posts = await postsPromise; // Won't be reached

      return { user, posts };
    };

    // Execute handler and expect it to throw
    await expect(handler()).rejects.toThrow("User is not active");

    // Verify retrieval phase was executed (both operations were registered)
    expect(parentUow.getRetrievalOperations()).toHaveLength(2);

    // Verify execution happened
    const log = executor.getLog();
    expect(log).toEqual(["RETRIEVAL: 2 queries"]);

    // No mutations should have been added since we threw during retrieval validation
    expect(parentUow.getMutationOperations()).toHaveLength(0);

    // Give Node.js event loop time to detect any unhandled rejections
    await new Promise((resolve) => setTimeout(resolve, 10));

    // If we got here without Node.js throwing an unhandled rejection, the test passes
  });

  it("should inherit idempotencyKey from parent to children for idempotent operations", () => {
    const executor = createMockExecutor();
    const parentUow = createUnitOfWork(createCompiler(), executor, createMockDecoder());

    // Parent UOW should have an idempotencyKey
    const parentIdempotencyKey = parentUow.idempotencyKey;
    expect(parentIdempotencyKey).toBeDefined();
    expect(typeof parentIdempotencyKey).toBe("string");
    expect(parentIdempotencyKey.length).toBeGreaterThan(0);

    // Create first child
    const child1 = parentUow.restrict();
    expect(child1.idempotencyKey).toBe(parentIdempotencyKey);

    // Create second child (sibling to child1)
    const child2 = parentUow.restrict();
    expect(child2.idempotencyKey).toBe(parentIdempotencyKey);

    // Create nested child (child of child1)
    const grandchild = child1.restrict();
    expect(grandchild.idempotencyKey).toBe(parentIdempotencyKey);

    // All UOWs in the hierarchy should share the same idempotencyKey
    expect(parentUow.idempotencyKey).toBe(child1.idempotencyKey);
    expect(child1.idempotencyKey).toBe(child2.idempotencyKey);
    expect(child2.idempotencyKey).toBe(grandchild.idempotencyKey);
  });

  it("should generate different idempotencyKeys for separate UOW hierarchies", () => {
    const executor = createMockExecutor();

    // Create two separate parent UOWs
    const parentUow1 = createUnitOfWork(createCompiler(), executor, createMockDecoder());
    const parentUow2 = createUnitOfWork(createCompiler(), executor, createMockDecoder());

    // They should have different idempotencyKeys
    expect(parentUow1.idempotencyKey).not.toBe(parentUow2.idempotencyKey);

    // But children within each hierarchy should inherit their parent's idempotencyKey
    const child1 = parentUow1.restrict();
    const child2 = parentUow2.restrict();

    expect(child1.idempotencyKey).toBe(parentUow1.idempotencyKey);
    expect(child2.idempotencyKey).toBe(parentUow2.idempotencyKey);
    expect(child1.idempotencyKey).not.toBe(child2.idempotencyKey);
  });

  it("should not cause unhandled rejection when service method awaits retrievalPhase and executeRetrieve fails", async () => {
    const testSchema = schema((s) =>
      s.addTable("settings", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("key", "string")
          .addColumn("value", "string")
          .createIndex("unique_key", ["key"], { unique: true }),
      ),
    );

    // Create executor that throws "table does not exist" error
    const failingExecutor: UOWExecutor<CompiledQuery, unknown> = {
      executeRetrievalPhase: async () => {
        throw new Error('relation "settings" does not exist');
      },
      executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
    };

    const parentUow = createUnitOfWork(createCompiler(), failingExecutor, createMockDecoder());

    // Service method that awaits retrievalPhase (simulating settingsService.get())
    const getSettingValue = async (key: string) => {
      const childUow = parentUow.restrict();
      const typedUow = childUow
        .forSchema(testSchema)
        .find("settings", (b) => b.whereIndex("unique_key", (eb) => eb("key", "=", key)));

      // This is the critical line - accessing retrievalPhase creates a new promise
      // If not cached properly, this new promise won't have a catch handler attached
      const [results] = await typedUow.retrievalPhase;
      return results?.[0];
    };

    const deferred = Promise.withResolvers<string>();

    // Handler that calls the service and handles the error
    const handler = async () => {
      try {
        const settingPromise = getSettingValue("version");

        await parentUow.executeRetrieve();

        // Won't reach here
        return await settingPromise;
      } catch (error) {
        // Error is caught here - this is expected behavior
        expect(error).toBeInstanceOf(Error);
        deferred.resolve((error as Error).message);
        return null;
      }
    };

    // Execute handler - should catch the error without unhandled rejection
    const result = await handler();
    expect(result).toBeNull();

    expect(await deferred.promise).toContain('relation "settings" does not exist');
  });

  it("should allow child UOW to call getCreatedIds() after parent executes mutations", async () => {
    const testSchema = schema((s) =>
      s.addTable("products", (t) =>
        t.addColumn("id", idColumn()).addColumn("name", "string").addColumn("price", "integer"),
      ),
    );

    const executor = createMockExecutor();
    const parentUow = createUnitOfWork(createCompiler(), executor, createMockDecoder());

    // Service method that creates a product using a child UOW and returns the child
    const createProduct = (name: string, price: number) => {
      const childUow = parentUow.restrict();
      const productId = childUow.forSchema(testSchema).create("products", { name, price });
      // Return both the child UOW and the product ID reference
      return { childUow, productId };
    };

    // Call service to create a product via child UOW
    const { childUow, productId } = createProduct("Widget", 1999);

    // Parent executes mutations
    await parentUow.executeMutations();

    // Child should be able to call getCreatedIds() after parent has executed
    // This tests that child checks parent's state, not its own stale state
    const createdIds = childUow.getCreatedIds();

    expect(createdIds).toHaveLength(1);
    expect(createdIds[0].externalId).toBe(productId.externalId);
  });

  it("should preserve internal IDs in child UOW when using two-phase pattern with mutationPhase await", async () => {
    const testSchema = schema((s) =>
      s.addTable("orders", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("customerId", "string")
          .addColumn("total", "integer"),
      ),
    );

    const executor = createMockExecutor();
    const parentUow = createUnitOfWork(createCompiler(), executor, createMockDecoder());

    // Service method that uses two-phase pattern (common with hooks/async operations)
    // This simulates a service that creates a record and needs to return the internal ID
    const createOrder = async (customerId: string, total: number) => {
      const childUow = parentUow.restrict();
      const typedUow = childUow.forSchema(testSchema);

      const orderId = typedUow.create("orders", { customerId, total });

      // Service awaits mutationPhase to coordinate with parent execution
      await childUow.mutationPhase;

      // After mutationPhase resolves, service should be able to get internal IDs
      const createdIds = childUow.getCreatedIds();
      const foundId = createdIds.find((id) => id.externalId === orderId.externalId);

      return {
        externalId: orderId.externalId,
        internalId: foundId?.internalId,
      };
    };

    // Handler orchestrates the service call and mutation execution
    const handler = async () => {
      const orderPromise = createOrder("customer-123", 9999);

      // Execute mutations - this should resolve the service's mutationPhase await
      await parentUow.executeMutations();

      // Now the service can complete and return the result with internal ID
      return await orderPromise;
    };

    const result = await handler();

    // The key assertion: internal ID should be defined (not undefined)
    // This tests that child UOW preserves shared reference to parent's createdInternalIds array
    expect(result.internalId).toBeDefined();
    expect(typeof result.internalId).toBe("bigint");
    expect(result.internalId).toBeGreaterThan(0n);
  });

  it("should fail when handler executes mutations before service finishes scheduling them (anti-pattern)", async () => {
    const testSchema = schema((s) =>
      s.addTable("totp_secret", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("userId", "string")
          .addColumn("secret", "string")
          .addColumn("backupCodes", "string")
          .createIndex("idx_totp_user", ["userId"]),
      ),
    );

    // Create executor that returns empty results (no existing record)
    const customExecutor: UOWExecutor<CompiledQuery, unknown> = {
      executeRetrievalPhase: async (queries: CompiledQuery[]) => {
        // Return empty array for each query (no existing records)
        return queries.map(() => []);
      },
      executeMutationPhase: async (mutations: CompiledMutation<CompiledQuery>[]) => {
        return {
          success: true,
          createdInternalIds: mutations.map(() => BigInt(Math.floor(Math.random() * 1000))),
        };
      },
    };

    const parentUow = createUnitOfWork(createCompiler(), customExecutor, createMockDecoder());

    // Service that has async work AFTER awaiting retrievalPhase but BEFORE scheduling mutations
    // This is a problematic pattern that can lead to race conditions
    const enableTotp = async (userId: string) => {
      const childUow = parentUow.restrict();
      const typedUow = childUow
        .forSchema(testSchema)
        .findFirst("totp_secret", (b) =>
          b.whereIndex("idx_totp_user", (eb) => eb("userId", "=", userId)),
        );

      // Service awaits retrieval phase
      const [existing] = await typedUow.retrievalPhase;

      if (existing) {
        throw new Error("TOTP already enabled");
      }

      // Simulate async work (like hashing backup codes) that yields control
      await new Promise((resolve) => setTimeout(resolve, 10));

      // By the time we get here, if the handler has already called executeMutate(),
      // the UOW will be in "executed" state and this will fail
      typedUow.create("totp_secret", {
        userId,
        secret: "TESTSECRET123",
        backupCodes: "[]",
      });

      await typedUow.mutationPhase;

      return { success: true };
    };

    // ANTI-PATTERN: Handler executes both phases immediately without awaiting service
    const badHandler = async () => {
      // Call service - returns promise immediately
      const resultPromise = enableTotp("user-123");

      // Execute retrieval phase
      await parentUow.executeRetrieve();

      // Execute mutation phase BEFORE service has finished scheduling mutations
      // This is the bug - service is still running async work and hasn't scheduled mutations yet
      await parentUow.executeMutations();

      // Now await service promise - but it's too late, UOW is already in "executed" state
      return await resultPromise;
    };

    // This should throw "Cannot add mutation operation in executed state"
    await expect(badHandler()).rejects.toThrow("Cannot add mutation operation in executed state");
  });

  it("should succeed when handler awaits service promise between phases (correct pattern)", async () => {
    const testSchema = schema((s) =>
      s.addTable("totp_secret", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("userId", "string")
          .addColumn("secret", "string")
          .addColumn("backupCodes", "string")
          .createIndex("idx_totp_user", ["userId"]),
      ),
    );

    // Create executor that returns empty results (no existing record)
    const customExecutor: UOWExecutor<CompiledQuery, unknown> = {
      executeRetrievalPhase: async (queries: CompiledQuery[]) => {
        return queries.map(() => []);
      },
      executeMutationPhase: async (mutations: CompiledMutation<CompiledQuery>[]) => {
        return {
          success: true,
          createdInternalIds: mutations.map(() => BigInt(Math.floor(Math.random() * 1000))),
        };
      },
    };

    const parentUow = createUnitOfWork(createCompiler(), customExecutor, createMockDecoder());

    // Same service as before - has async work between retrieval and mutation scheduling
    const enableTotp = async (userId: string) => {
      const childUow = parentUow.restrict();
      const typedUow = childUow
        .forSchema(testSchema)
        .findFirst("totp_secret", (b) =>
          b.whereIndex("idx_totp_user", (eb) => eb("userId", "=", userId)),
        );

      const [existing] = await typedUow.retrievalPhase;

      if (existing) {
        throw new Error("TOTP already enabled");
      }

      // Simulate async work (like hashing backup codes)
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Schedule mutation - this will work because handler waits for service to finish
      typedUow.create("totp_secret", {
        userId,
        secret: "TESTSECRET123",
        backupCodes: "[]",
      });

      return { success: true };
    };

    // CORRECT PATTERN: Handler awaits service promise between phase executions
    const goodHandler = async () => {
      // Call service first - it schedules retrieval operations synchronously
      const resultPromise = enableTotp("user-123");

      // Execute retrieval phase - service can now continue past its retrieval await
      await parentUow.executeRetrieve();

      // Wait for service to finish - it will schedule mutations
      const result = await resultPromise;

      // Execute mutations that service scheduled
      await parentUow.executeMutations();

      return result;
    };

    // This should succeed without errors
    const result = await goodHandler();
    expect(result.success).toBe(true);

    // Verify operations were registered
    expect(parentUow.getRetrievalOperations()).toHaveLength(1);
    expect(parentUow.getMutationOperations()).toHaveLength(1);
  });
});
