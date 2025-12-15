import { describe, it, expect } from "vitest";
import { schema, idColumn, type FragnoId, referenceColumn } from "../../schema/create";
import {
  type UOWCompiler,
  type UOWDecoder,
  createUnitOfWork,
  type RetrievalOperation,
  type MutationOperation,
  type CompiledMutation,
} from "./unit-of-work";
import type { AnySchema } from "../../schema/create";

// Mock compiler that tracks operations
function createMockCompiler(): UOWCompiler<string> {
  return {
    compileRetrievalOperation: (op: RetrievalOperation<AnySchema>) => {
      return `SELECT from ${op.table.ormName}`;
    },
    compileMutationOperation: (op: MutationOperation<AnySchema>) => {
      return {
        query: `${op.type.toUpperCase()} ${op.table}`,
        expectedAffectedRows: op.type === "create" ? null : op.type === "check" ? null : 1n,
        expectedReturnedRows: op.type === "check" ? 1 : null,
      };
    },
  };
}

// Mock executor that tracks execution
function createMockExecutor() {
  const executionLog: string[] = [];

  return {
    executeRetrievalPhase: async (queries: string[]) => {
      executionLog.push(`RETRIEVAL: ${queries.length} queries`);
      // Return mock results for each query
      return queries.map(() => [{ id: "mock-id", name: "Mock User" }]);
    },
    executeMutationPhase: async (mutations: CompiledMutation<string>[]) => {
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
    const parentUow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());

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
    const parentUow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());

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
    const parentUow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());

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
    const parentUow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());

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
    const parentUow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());

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
    const customExecutor = {
      executeRetrievalPhase: async (queries: string[]) => {
        executionLog.push(`RETRIEVAL: ${queries.length} queries`);
        // Return mock account data with balance field set to low value
        return queries.map(() => [{ id: "mock-id", userId: "user-1", balance: 100 }]);
      },
      executeMutationPhase: async (mutations: CompiledMutation<string>[]) => {
        executionLog.push(`MUTATION: ${mutations.length} mutations`);
        return {
          success: true,
          createdInternalIds: mutations.map(() => BigInt(Math.floor(Math.random() * 1000))),
        };
      },
    };

    const parentUow = createUnitOfWork(createMockCompiler(), customExecutor, createMockDecoder());

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
    const parentUow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());

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

  it("should inherit nonce from parent to children for idempotent operations", () => {
    const executor = createMockExecutor();
    const parentUow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());

    // Parent UOW should have a nonce
    const parentNonce = parentUow.nonce;
    expect(parentNonce).toBeDefined();
    expect(typeof parentNonce).toBe("string");
    expect(parentNonce.length).toBeGreaterThan(0);

    // Create first child
    const child1 = parentUow.restrict();
    expect(child1.nonce).toBe(parentNonce);

    // Create second child (sibling to child1)
    const child2 = parentUow.restrict();
    expect(child2.nonce).toBe(parentNonce);

    // Create nested child (child of child1)
    const grandchild = child1.restrict();
    expect(grandchild.nonce).toBe(parentNonce);

    // All UOWs in the hierarchy should share the same nonce
    expect(parentUow.nonce).toBe(child1.nonce);
    expect(child1.nonce).toBe(child2.nonce);
    expect(child2.nonce).toBe(grandchild.nonce);
  });

  it("should generate different nonces for separate UOW hierarchies", () => {
    const executor = createMockExecutor();

    // Create two separate parent UOWs
    const parentUow1 = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());
    const parentUow2 = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());

    // They should have different nonces
    expect(parentUow1.nonce).not.toBe(parentUow2.nonce);

    // But children within each hierarchy should inherit their parent's nonce
    const child1 = parentUow1.restrict();
    const child2 = parentUow2.restrict();

    expect(child1.nonce).toBe(parentUow1.nonce);
    expect(child2.nonce).toBe(parentUow2.nonce);
    expect(child1.nonce).not.toBe(child2.nonce);
  });

  it.skip("should not cause unhandled rejection when service method awaits retrievalPhase and executeRetrieve fails", async () => {
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
    const failingExecutor = {
      executeRetrievalPhase: async () => {
        throw new Error('relation "settings" does not exist');
      },
      executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
    };

    const parentUow = createUnitOfWork(createMockCompiler(), failingExecutor, createMockDecoder());

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
});
