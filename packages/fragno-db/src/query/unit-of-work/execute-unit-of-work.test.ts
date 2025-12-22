import { describe, it, expect, vi, assert, expectTypeOf } from "vitest";
import { schema, idColumn, FragnoId } from "../../schema/create";
import {
  createUnitOfWork,
  type TypedUnitOfWork,
  type IUnitOfWork,
  type UOWCompiler,
  type UOWDecoder,
  type UOWExecutor,
} from "./unit-of-work";
import {
  executeUnitOfWork,
  executeRestrictedUnitOfWork,
  executeTxArray,
  executeTxCallbacks,
  executeServiceTx,
} from "./execute-unit-of-work";
import {
  ExponentialBackoffRetryPolicy,
  LinearBackoffRetryPolicy,
  NoRetryPolicy,
} from "./retry-policy";
import type { AwaitedPromisesInObject } from "./execute-unit-of-work";

// Create test schema
const testSchema = schema((s) =>
  s.addTable("users", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("email", "string")
      .addColumn("name", "string")
      .addColumn("balance", "integer")
      .createIndex("idx_email", ["email"], { unique: true }),
  ),
);

// Type tests for AwaitedPromisesInObject
describe("AwaitedPromisesInObject type tests", () => {
  it("should unwrap promises in objects", () => {
    type Input = { a: Promise<string>; b: number };
    type Expected = { a: string; b: number };
    type Actual = AwaitedPromisesInObject<Input>;
    expectTypeOf<Actual>().toMatchObjectType<Expected>();
  });

  it("should unwrap promises in arrays", () => {
    type Input = Promise<string>[];
    type Expected = string[];
    type Actual = AwaitedPromisesInObject<Input>;
    expectTypeOf<Actual>().toEqualTypeOf<Expected>();
  });

  it("should unwrap direct promises", () => {
    type Input = Promise<{ value: number }>;
    type Expected = { value: number };
    type Actual = AwaitedPromisesInObject<Input>;
    expectTypeOf<Actual>().toEqualTypeOf<Expected>();
  });

  it("should handle tuples correctly", () => {
    type Input = [Promise<string>, Promise<number>];
    type Actual = AwaitedPromisesInObject<Input>;

    // Should preserve tuple structure - check first and second elements
    expectTypeOf<Actual[0]>().toEqualTypeOf<string>();
    expectTypeOf<Actual[1]>().toEqualTypeOf<number>();

    // Verify it's actually a tuple with length 2
    expectTypeOf<Actual["length"]>().toEqualTypeOf<2>();
  });

  it("should preserve tuple structure with Promise.all pattern", () => {
    type User = { id: string; name: string };
    type Order = { id: string; total: number };

    type Input = [Promise<User>, Promise<Order[]>];
    type Actual = AwaitedPromisesInObject<Input>;

    // Check individual elements
    expectTypeOf<Actual[0]>().toMatchObjectType<User>();
    expectTypeOf<Actual[1]>().toEqualTypeOf<Order[]>();

    // Verify length
    expectTypeOf<Actual["length"]>().toEqualTypeOf<2>();
  });

  it("should handle readonly tuples", () => {
    type Input = readonly [Promise<string>, Promise<number>];
    type Actual = AwaitedPromisesInObject<Input>;

    // Check elements
    expectTypeOf<Actual[0]>().toEqualTypeOf<string>();
    expectTypeOf<Actual[1]>().toEqualTypeOf<number>();
  });

  it("should handle tuples with more than 2 elements", () => {
    type Input = [Promise<string>, Promise<number>, Promise<boolean>];
    type Actual = AwaitedPromisesInObject<Input>;

    // Check all three elements
    expectTypeOf<Actual[0]>().toEqualTypeOf<string>();
    expectTypeOf<Actual[1]>().toEqualTypeOf<number>();
    expectTypeOf<Actual[2]>().toEqualTypeOf<boolean>();
    expectTypeOf<Actual["length"]>().toEqualTypeOf<3>();
  });

  it("should handle tuples with mixed promise and non-promise types", () => {
    type Input = [Promise<string>, number, Promise<boolean>];
    type Actual = AwaitedPromisesInObject<Input>;

    // Non-promises should be preserved as-is
    expectTypeOf<Actual[0]>().toEqualTypeOf<string>();
    expectTypeOf<Actual[1]>().toEqualTypeOf<number>();
    expectTypeOf<Actual[2]>().toEqualTypeOf<boolean>();
  });
});

// Mock compiler that returns null for all operations
function createMockCompiler(): UOWCompiler<unknown> {
  return {
    compileRetrievalOperation: () => null,
    compileMutationOperation: () => null,
  };
}

// Mock decoder that returns raw results as-is
function createMockDecoder(): UOWDecoder {
  return {
    decode(rawResults) {
      return rawResults;
    },
  };
}

// Helper to create a UOW factory that tracks how many times it's called
function createMockUOWFactory(mutationResults: Array<{ success: boolean }>) {
  const callCount = { value: 0 };
  // Share callIndex across all UOW instances
  let callIndex = 0;

  const factory = () => {
    callCount.value++;

    // Create executor that uses shared callIndex
    const executor: UOWExecutor<unknown, unknown> = {
      executeRetrievalPhase: async () => {
        return [
          [
            {
              id: FragnoId.fromExternal("user-1", 1),
              email: "test@example.com",
              name: "Test User",
              balance: 100,
            },
          ],
        ];
      },
      executeMutationPhase: async () => {
        const result = mutationResults[callIndex] || { success: false };
        callIndex++;
        return { ...result, createdInternalIds: [] };
      },
    };

    return createUnitOfWork(createMockCompiler(), executor, createMockDecoder()).forSchema(
      testSchema,
    );
  };
  return { factory, callCount };
}

describe("executeUnitOfWork", () => {
  describe("validation", () => {
    it("should throw error when neither retrieve nor mutate is provided", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);

      await expect(executeUnitOfWork({}, { createUnitOfWork: factory })).rejects.toThrow(
        "At least one of 'retrieve' or 'mutate' callbacks must be provided",
      );
    });
  });

  describe("success scenarios", () => {
    it("should succeed on first attempt without retries", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);
      const onSuccess = vi.fn();

      const result = await executeUnitOfWork(
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("primary")),
          mutate: (uow, [users]) => {
            const newBalance = users[0].balance + 100;
            uow.update("users", users[0].id, (b) => b.set({ balance: newBalance }).check());
            return { newBalance };
          },
          onSuccess,
        },
        { createUnitOfWork: factory },
      );

      assert(result.success);
      expect(result.mutationResult).toEqual({ newBalance: 200 });
      expect(onSuccess).toHaveBeenCalledExactlyOnceWith({
        results: expect.any(Array),
        mutationResult: { newBalance: 200 },
        createdIds: [],
        nonce: expect.any(String),
      });
    });
  });

  describe("retry scenarios", () => {
    it("should retry on conflict with eventual success", async () => {
      const { factory, callCount } = createMockUOWFactory([
        { success: false },
        { success: false },
        { success: true },
      ]);

      const result = await executeUnitOfWork(
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("primary")),
          mutate: async (uow, [users]) => {
            uow.update("users", users[0].id, (b) => b.set({ balance: 200 }).check());
          },
        },
        {
          createUnitOfWork: factory,
          retryPolicy: new ExponentialBackoffRetryPolicy({ maxRetries: 3, initialDelayMs: 1 }),
        },
      );

      expect(result.success).toBe(true);
      expect(callCount.value).toBe(3); // Initial + 2 retries
    });

    it("should fail when max retries exceeded", async () => {
      const { factory, callCount } = createMockUOWFactory([
        { success: false },
        { success: false },
        { success: false },
        { success: false },
      ]);

      const result = await executeUnitOfWork(
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("primary")),
          mutate: async (uow, [users]) => {
            uow.update("users", users[0].id, (b) => b.set({ balance: 200 }));
          },
        },
        {
          createUnitOfWork: factory,
          retryPolicy: new ExponentialBackoffRetryPolicy({ maxRetries: 2, initialDelayMs: 1 }),
        },
      );

      assert(!result.success);
      expect(result.reason).toBe("conflict");
      expect(callCount.value).toBe(3); // Initial + 2 retries
    });

    it("should create fresh UOW on each retry attempt", async () => {
      const { factory, callCount } = createMockUOWFactory([
        { success: false },
        { success: false },
        { success: true },
      ]);

      await executeUnitOfWork(
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("primary")),
          mutate: async (uow, [users]) => {
            uow.update("users", users[0].id, (b) => b.set({ balance: 200 }));
          },
        },
        {
          createUnitOfWork: factory,
          retryPolicy: new LinearBackoffRetryPolicy({ maxRetries: 3, delayMs: 1 }),
        },
      );

      expect(callCount.value).toBe(3); // Each attempt creates a new UOW
    });
  });

  describe("AbortSignal handling", () => {
    it("should abort when signal is aborted before execution", async () => {
      const { factory } = createMockUOWFactory([{ success: false }]);
      const controller = new AbortController();
      controller.abort();

      const result = await executeUnitOfWork(
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("primary")),
          mutate: async (uow, [users]) => {
            uow.update("users", users[0].id, (b) => b.set({ balance: 200 }));
          },
        },
        {
          createUnitOfWork: factory,
          retryPolicy: new ExponentialBackoffRetryPolicy({ maxRetries: 5, initialDelayMs: 1 }),
          signal: controller.signal,
        },
      );

      assert(!result.success);
      expect(result.reason).toBe("aborted");
    });

    it("should abort when signal is aborted during retry", async () => {
      const { factory } = createMockUOWFactory([{ success: false }, { success: false }]);
      const controller = new AbortController();

      // Abort after first attempt
      setTimeout(() => controller.abort(), 50);

      const result = await executeUnitOfWork(
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("primary")),
          mutate: async (uow, [users]) => {
            uow.update("users", users[0].id, (b) => b.set({ balance: 200 }));
          },
        },
        {
          createUnitOfWork: factory,
          retryPolicy: new LinearBackoffRetryPolicy({ maxRetries: 5, delayMs: 100 }),
          signal: controller.signal,
        },
      );

      assert(!result.success);
      expect(result.reason).toBe("aborted");
    });
  });

  describe("onSuccess callback", () => {
    it("should pass mutation result to onSuccess callback", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);
      const onSuccess = vi.fn();

      await executeUnitOfWork(
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("primary")),
          mutate: async () => {
            return { updatedCount: 5 };
          },
          onSuccess,
        },
        { createUnitOfWork: factory },
      );

      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(onSuccess).toHaveBeenCalledWith({
        results: expect.any(Array),
        mutationResult: { updatedCount: 5 },
        createdIds: [],
        nonce: expect.any(String),
      });
    });

    it("should only execute onSuccess callback on success", async () => {
      const { factory } = createMockUOWFactory([{ success: false }]);
      const onSuccess = vi.fn();

      const result = await executeUnitOfWork(
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("primary")),
          mutate: async (uow, [users]) => {
            uow.update("users", users[0].id, (b) => b.set({ balance: 200 }));
          },
          onSuccess,
        },
        {
          createUnitOfWork: factory,
          retryPolicy: new NoRetryPolicy(),
        },
      );

      assert(!result.success);
      expect(result.reason).toBe("conflict");
      expect(onSuccess).not.toHaveBeenCalled();
    });

    it("should execute onSuccess only once even after retries", async () => {
      const { factory } = createMockUOWFactory([
        { success: false },
        { success: false },
        { success: true },
      ]);
      const onSuccess = vi.fn();

      await executeUnitOfWork(
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("primary")),
          mutate: async (uow, [users]) => {
            uow.update("users", users[0].id, (b) => b.set({ balance: 200 }));
          },
          onSuccess,
        },
        {
          createUnitOfWork: factory,
          retryPolicy: new ExponentialBackoffRetryPolicy({ maxRetries: 3, initialDelayMs: 1 }),
        },
      );

      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    it("should handle async onSuccess callback", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);
      const onSuccess = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      await executeUnitOfWork(
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("primary")),
          mutate: async (uow, [users]) => {
            uow.update("users", users[0].id, (b) => b.set({ balance: 200 }));
          },
          onSuccess,
        },
        { createUnitOfWork: factory },
      );

      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
  });

  describe("error handling", () => {
    it("should return error result when retrieve callback throws", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);
      const testError = new Error("Retrieve failed");

      const result = await executeUnitOfWork(
        {
          retrieve: () => {
            throw testError;
          },
          mutate: async () => {},
        },
        { createUnitOfWork: factory },
      );

      assert(!result.success);
      assert(result.reason === "error");
      expect(result.error).toBe(testError);
    });

    it("should return error result when mutate callback throws", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);
      const testError = new Error("Mutate failed");

      const result = await executeUnitOfWork(
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("primary")),
          mutate: async () => {
            throw testError;
          },
        },
        { createUnitOfWork: factory },
      );

      assert(!result.success);
      assert(result.reason === "error");
      expect(result.error).toBe(testError);
    });

    it("should return error result when onSuccess callback throws", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);
      const testError = new Error("onSuccess failed");

      const result = await executeUnitOfWork(
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("primary")),
          mutate: async () => {},
          onSuccess: async () => {
            throw testError;
          },
        },
        { createUnitOfWork: factory },
      );

      assert(!result.success);
      assert(result.reason === "error");
      expect(result.error).toBe(testError);
    });

    it("should capture non-Error thrown values", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);

      const result = await executeUnitOfWork(
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("primary")),
          mutate: async () => {
            throw "string error";
          },
        },
        { createUnitOfWork: factory },
      );

      assert(!result.success);
      assert(result.reason === "error");
      expect(result.error).toBe("string error");
    });
  });

  describe("retrieval results", () => {
    it("should pass retrieval results to mutation phase", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);
      const mutationPhase = vi.fn(async (_uow: unknown, _results: unknown) => {});

      await executeUnitOfWork(
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("primary")),
          mutate: mutationPhase,
        },
        { createUnitOfWork: factory },
      );

      expect(mutationPhase).toHaveBeenCalledTimes(1);
      const call = mutationPhase.mock.calls[0];
      assert(call);
      const [_uow, results] = call;
      expect(results).toBeInstanceOf(Array);
      expect(results as unknown[]).toHaveLength(1);
      expect((results as unknown[])[0]).toBeInstanceOf(Array);
    });

    it("should return retrieval results in the result object", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);

      const result = await executeUnitOfWork(
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("primary")),
          mutate: async () => {},
        },
        { createUnitOfWork: factory },
      );

      assert(result.success);
      expect(result.results).toBeInstanceOf(Array);
      expect(result.results).toHaveLength(1);
    });
  });

  describe("promise awaiting in mutation result", () => {
    it("should await promises in mutation result object (1 level deep)", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);

      const result = await executeUnitOfWork(
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("primary")),
          mutate: async () => {
            return {
              userId: Promise.resolve("user-123"),
              count: Promise.resolve(42),
              data: "plain-value",
            };
          },
        },
        { createUnitOfWork: factory },
      );

      assert(result.success);
      expect(result.mutationResult).toEqual({
        userId: "user-123",
        count: 42,
        data: "plain-value",
      });
    });

    it("should await promises in mutation result array", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);

      const result = await executeUnitOfWork(
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("primary")),
          mutate: async () => {
            return [Promise.resolve("a"), Promise.resolve("b"), "c"];
          },
        },
        { createUnitOfWork: factory },
      );

      assert(result.success);
      expect(result.mutationResult).toEqual(["a", "b", "c"]);
    });

    it("should await direct promise mutation result", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);

      const result = await executeUnitOfWork(
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("primary")),
          mutate: async () => {
            return Promise.resolve({ value: "resolved" });
          },
        },
        { createUnitOfWork: factory },
      );

      assert(result.success);
      expect(result.mutationResult).toEqual({ value: "resolved" });
    });

    it("should NOT await nested promises (only 1 level deep)", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);

      const result = await executeUnitOfWork(
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("primary")),
          mutate: async () => {
            return {
              nested: { promise: Promise.resolve("still-a-promise") },
            };
          },
        },
        { createUnitOfWork: factory },
      );

      assert(result.success);
      // The nested promise should still be a promise
      expect(result.mutationResult.nested.promise).toBeInstanceOf(Promise);
    });

    it("should handle mixed types in mutation result", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);

      const result = await executeUnitOfWork(
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("primary")),
          mutate: async () => {
            return {
              promise: Promise.resolve(100),
              number: 42,
              string: "test",
              null: null,
              undefined: undefined,
              nested: { value: "nested" },
            };
          },
        },
        { createUnitOfWork: factory },
      );

      assert(result.success);
      expect(result.mutationResult).toEqual({
        promise: 100,
        number: 42,
        string: "test",
        null: null,
        undefined: undefined,
        nested: { value: "nested" },
      });
    });

    it("should pass awaited mutation result to onSuccess callback", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);
      const onSuccess = vi.fn();

      await executeUnitOfWork(
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("primary")),
          mutate: async () => {
            return {
              userId: Promise.resolve("user-456"),
              status: Promise.resolve("active"),
            };
          },
          onSuccess,
        },
        { createUnitOfWork: factory },
      );

      expect(onSuccess).toHaveBeenCalledExactlyOnceWith({
        results: expect.any(Array),
        mutationResult: {
          userId: "user-456",
          status: "active",
        },
        createdIds: [],
        nonce: expect.any(String),
      });
    });
  });
});

describe("executeRestrictedUnitOfWork", () => {
  describe("basic success cases", () => {
    it("should execute a simple mutation-only workflow", async () => {
      const { factory, callCount } = createMockUOWFactory([{ success: true }]);

      const result = await executeRestrictedUnitOfWork(
        async ({ forSchema, executeMutate }) => {
          const uow = forSchema(testSchema);
          const userId = uow.create("users", {
            id: "user-1",
            email: "test@example.com",
            name: "Test User",
            balance: 100,
          });

          await executeMutate();

          return { userId: userId.externalId };
        },
        { createUnitOfWork: factory },
      );

      expect(result).toEqual({ userId: "user-1" });
      expect(callCount.value).toBe(1);
    });

    it("should execute retrieval and mutation phases", async () => {
      const { factory, callCount } = createMockUOWFactory([{ success: true }]);

      const result = await executeRestrictedUnitOfWork(
        async ({ forSchema, executeRetrieve, executeMutate }) => {
          const uow = forSchema(testSchema).find("users", (b) => b.whereIndex("primary"));
          await executeRetrieve();
          const [[user]] = await uow.retrievalPhase;

          uow.update("users", user.id, (b) => b.set({ balance: user.balance + 50 }).check());
          await executeMutate();

          return { newBalance: user.balance + 50 };
        },
        { createUnitOfWork: factory },
      );

      expect(result).toEqual({ newBalance: 150 });
      expect(callCount.value).toBe(1);
    });

    it("should return callback result directly", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);

      const result = await executeRestrictedUnitOfWork(
        async () => {
          return { data: "test", count: 42, nested: { value: true } };
        },
        { createUnitOfWork: factory },
      );

      expect(result).toEqual({ data: "test", count: 42, nested: { value: true } });
    });
  });

  describe("retry behavior", () => {
    it("should retry on conflict and eventually succeed", async () => {
      const { factory, callCount } = createMockUOWFactory([
        { success: false }, // First attempt fails
        { success: false }, // Second attempt fails
        { success: true }, // Third attempt succeeds
      ]);

      const callbackExecutions = { count: 0 };

      const result = await executeRestrictedUnitOfWork(
        async ({ forSchema, executeMutate }) => {
          callbackExecutions.count++;
          const uow = forSchema(testSchema);

          uow.create("users", {
            id: "user-1",
            email: "test@example.com",
            name: "Test User",
            balance: 100,
          });

          await executeMutate();

          return { attempt: callbackExecutions.count };
        },
        { createUnitOfWork: factory },
      );

      expect(result.attempt).toBe(3);
      expect(callCount.value).toBe(3);
      expect(callbackExecutions.count).toBe(3);
    });

    it("should throw error when retries are exhausted", async () => {
      const { factory, callCount } = createMockUOWFactory([
        { success: false }, // First attempt fails
        { success: false }, // Second attempt fails
        { success: false }, // Third attempt fails
        { success: false }, // Fourth attempt fails (exceeds default maxRetries: 3)
      ]);

      await expect(
        executeRestrictedUnitOfWork(
          async ({ executeMutate }) => {
            await executeMutate();
            return { hello: "world" };
          },
          { createUnitOfWork: factory },
        ),
      ).rejects.toThrow("Unit of Work execution failed: optimistic concurrency conflict");

      // Default policy has maxRetries: 5, so we make 6 attempts (initial + 5 retries)
      expect(callCount.value).toBe(6);
    });

    it("should respect custom retry policy", async () => {
      const { factory, callCount } = createMockUOWFactory([
        { success: false },
        { success: false },
        { success: false },
        { success: false },
        { success: false },
        { success: true },
      ]);

      const result = await executeRestrictedUnitOfWork(
        async ({ executeMutate }) => {
          await executeMutate();
          return { done: true };
        },
        {
          createUnitOfWork: factory,
          retryPolicy: new ExponentialBackoffRetryPolicy({ maxRetries: 5, initialDelayMs: 1 }),
        },
      );

      expect(result).toEqual({ done: true });
      expect(callCount.value).toBe(6); // Initial + 5 retries
    });

    it("should use default ExponentialBackoffRetryPolicy with small delays", async () => {
      const { factory } = createMockUOWFactory([{ success: false }, { success: true }]);

      const startTime = Date.now();
      await executeRestrictedUnitOfWork(
        async ({ executeMutate }) => {
          await executeMutate();
          return {};
        },
        { createUnitOfWork: factory },
      );
      const elapsed = Date.now() - startTime;

      // Default policy has initialDelayMs: 10, maxDelayMs: 100
      // First retry delay should be around 10ms
      expect(elapsed).toBeLessThan(200); // Allow some margin
    });
  });

  describe("error handling", () => {
    it("should throw error from callback immediately without retry", async () => {
      const { factory, callCount } = createMockUOWFactory([{ success: true }]);

      await expect(
        executeRestrictedUnitOfWork(
          async () => {
            throw new Error("Callback error");
          },
          { createUnitOfWork: factory },
        ),
      ).rejects.toThrow("Callback error");

      // Should NOT retry non-conflict errors
      expect(callCount.value).toBe(1); // Only initial attempt
    });

    it("should throw callback error directly", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);
      const originalError = new Error("Original error");

      try {
        await executeRestrictedUnitOfWork(
          async () => {
            throw originalError;
          },
          {
            createUnitOfWork: factory,
            retryPolicy: new NoRetryPolicy(), // Don't retry
          },
        );
        expect.fail("Should have thrown");
      } catch (error) {
        // Error should be thrown directly, not wrapped
        expect(error).toBe(originalError);
      }
    });
  });

  describe("abort signal", () => {
    it("should throw when aborted before execution", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);
      const controller = new AbortController();
      controller.abort();

      await expect(
        executeRestrictedUnitOfWork(
          async () => {
            return {};
          },
          { createUnitOfWork: factory, signal: controller.signal },
        ),
      ).rejects.toThrow("Unit of Work execution aborted");
    });

    it("should stop retrying when aborted during retry", async () => {
      const { factory, callCount } = createMockUOWFactory([
        { success: false },
        { success: false },
        { success: true },
      ]);
      const controller = new AbortController();

      const promise = executeRestrictedUnitOfWork(
        async ({ executeMutate }) => {
          if (callCount.value === 2) {
            controller.abort();
          }
          await executeMutate();
          return {};
        },
        { createUnitOfWork: factory, signal: controller.signal },
      );

      await expect(promise).rejects.toThrow("Unit of Work execution aborted");
      expect(callCount.value).toBeLessThanOrEqual(2);
    });
  });

  describe("restricted UOW interface", () => {
    it("should provide access to forSchema", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);

      await executeRestrictedUnitOfWork(
        async ({ forSchema }) => {
          const uow = forSchema(testSchema);
          expect(uow).toBeDefined();
          expect(uow.schema).toBe(testSchema);
          return {};
        },
        { createUnitOfWork: factory },
      );
    });

    it("should allow creating entities via forSchema", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);

      const result = await executeRestrictedUnitOfWork(
        async ({ forSchema, executeRetrieve, executeMutate }) => {
          const uow = forSchema(testSchema);
          await executeRetrieve();

          const userId = uow.create("users", {
            id: "user-123",
            email: "test@example.com",
            name: "Test",
            balance: 0,
          });

          await executeMutate();

          return { userId };
        },
        { createUnitOfWork: factory },
      );

      expect(result.userId).toBeInstanceOf(FragnoId);
      expect(result.userId.externalId).toBe("user-123");
    });
  });

  describe("promise awaiting in callback result", () => {
    it("should await promises in result object (1 level deep)", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);

      const result = await executeRestrictedUnitOfWork(
        async ({ executeMutate }) => {
          await executeMutate();
          return {
            userId: Promise.resolve("user-123"),
            profileId: Promise.resolve("profile-456"),
            status: "completed",
          };
        },
        { createUnitOfWork: factory },
      );

      expect(result).toEqual({
        userId: "user-123",
        profileId: "profile-456",
        status: "completed",
      });
    });

    it("should await promises in result array", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);

      const result = await executeRestrictedUnitOfWork(
        async ({ executeMutate }) => {
          await executeMutate();
          return [Promise.resolve(1), Promise.resolve(2), 3];
        },
        { createUnitOfWork: factory },
      );

      expect(result).toEqual([1, 2, 3]);
    });

    it("should await direct promise result", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);

      const result = await executeRestrictedUnitOfWork(
        async ({ executeMutate }) => {
          await executeMutate();
          return Promise.resolve({ data: "test" });
        },
        { createUnitOfWork: factory },
      );

      expect(result).toEqual({ data: "test" });
    });

    it("should NOT await nested promises (only 1 level deep)", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);

      const result = await executeRestrictedUnitOfWork(
        async ({ executeMutate }) => {
          await executeMutate();
          return {
            nested: {
              promise: Promise.resolve("still-a-promise"),
            },
          };
        },
        { createUnitOfWork: factory },
      );

      // The nested promise should still be a promise
      expect(result.nested.promise).toBeInstanceOf(Promise);
    });

    it("should handle mixed types in result", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);

      const result = await executeRestrictedUnitOfWork(
        async ({ executeMutate }) => {
          await executeMutate();
          return {
            promise: Promise.resolve("resolved"),
            number: 42,
            string: "test",
            boolean: true,
            null: null,
            undefined: undefined,
            object: { nested: "value" },
          };
        },
        { createUnitOfWork: factory },
      );

      expect(result).toEqual({
        promise: "resolved",
        number: 42,
        string: "test",
        boolean: true,
        null: null,
        undefined: undefined,
        object: { nested: "value" },
      });
    });

    it("should await promises even after retries", async () => {
      const { factory, callCount } = createMockUOWFactory([{ success: false }, { success: true }]);

      const result = await executeRestrictedUnitOfWork(
        async ({ executeMutate }) => {
          await executeMutate();
          return {
            attempt: callCount.value,
            data: Promise.resolve("final-result"),
          };
        },
        { createUnitOfWork: factory },
      );

      expect(result).toEqual({
        attempt: 2,
        data: "final-result",
      });
    });

    it("should handle complex objects with multiple promises at top level", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);

      const result = await executeRestrictedUnitOfWork(
        async ({ executeMutate }) => {
          await executeMutate();
          return {
            userId: Promise.resolve("user-1"),
            email: Promise.resolve("test@example.com"),
            count: Promise.resolve(100),
            active: Promise.resolve(true),
            metadata: {
              timestamp: Date.now(),
              version: 1,
            },
          };
        },
        { createUnitOfWork: factory },
      );

      expect(typeof result.userId).toBe("string");
      expect(result.userId).toBe("user-1");
      expect(typeof result.email).toBe("string");
      expect(result.email).toBe("test@example.com");
      expect(typeof result.count).toBe("number");
      expect(result.count).toBe(100);
      expect(typeof result.active).toBe("boolean");
      expect(result.active).toBe(true);
      expect(typeof result.metadata.timestamp).toBe("number");
      expect(result.metadata.version).toBe(1);
    });

    it("should handle empty object result", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);

      const result = await executeRestrictedUnitOfWork(
        async ({ executeMutate }) => {
          await executeMutate();
          return {};
        },
        { createUnitOfWork: factory },
      );

      expect(result).toEqual({});
    });

    it("should handle primitive result types", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);

      const stringResult = await executeRestrictedUnitOfWork(
        async ({ executeMutate }) => {
          await executeMutate();
          return "test-string";
        },
        { createUnitOfWork: factory },
      );

      expect(stringResult).toBe("test-string");

      const { factory: factory2 } = createMockUOWFactory([{ success: true }]);
      const numberResult = await executeRestrictedUnitOfWork(
        async ({ executeMutate }) => {
          await executeMutate();
          return 42;
        },
        { createUnitOfWork: factory2 },
      );

      expect(numberResult).toBe(42);
    });
  });

  describe("tuple return types", () => {
    it("should await promises in tuple and preserve tuple structure", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);

      const result = await executeRestrictedUnitOfWork(
        async ({ executeMutate }) => {
          await executeMutate();
          // Return a tuple with promises
          return [Promise.resolve("user-123"), Promise.resolve(42)] as const;
        },
        { createUnitOfWork: factory },
      );

      // Runtime behavior: promises should be awaited
      expect(result).toEqual(["user-123", 42]);
      expect(result[0]).toBe("user-123");
      expect(result[1]).toBe(42);
    });

    it("should handle tuple with mixed promise and non-promise values", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);

      const result = await executeRestrictedUnitOfWork(
        async ({ executeMutate }) => {
          await executeMutate();
          // Tuple with mixed types
          return [Promise.resolve("first"), "second", Promise.resolve(3)] as const;
        },
        { createUnitOfWork: factory },
      );

      expect(result).toEqual(["first", "second", 3]);
      expect(result[0]).toBe("first");
      expect(result[1]).toBe("second");
      expect(result[2]).toBe(3);
    });

    it("should handle Promise.all pattern with tuple", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);

      const result = await executeRestrictedUnitOfWork(
        async ({ executeMutate }) => {
          await executeMutate();
          // Simulate the pattern from db-fragment-integration.test.ts
          const userPromise = Promise.resolve({ id: "user-1", name: "John" });
          const ordersPromise = Promise.resolve([
            { id: "order-1", total: 100 },
            { id: "order-2", total: 200 },
          ]);
          return await Promise.all([userPromise, ordersPromise]);
        },
        { createUnitOfWork: factory },
      );

      // Runtime behavior
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ id: "user-1", name: "John" });
      expect(result[1]).toEqual([
        { id: "order-1", total: 100 },
        { id: "order-2", total: 200 },
      ]);

      // Type check: result should be [{ id: string; name: string }, { id: string; total: number }[]]
      // But with current implementation, it's incorrectly typed as an array union
      const [user, orders] = result;
      expect(user).toBeDefined();
      expect(orders).toBeDefined();
    });

    it("should handle array (not tuple) with promises", async () => {
      const { factory } = createMockUOWFactory([{ success: true }]);

      const result = await executeRestrictedUnitOfWork(
        async ({ executeMutate }) => {
          await executeMutate();
          // Regular array (not a tuple)
          const items = [Promise.resolve(1), Promise.resolve(2), Promise.resolve(3)];
          return items;
        },
        { createUnitOfWork: factory },
      );

      expect(result).toEqual([1, 2, 3]);
      expect(result).toHaveLength(3);
    });
  });

  describe("unhandled rejection handling", () => {
    it("should not cause unhandled rejection when service method awaits retrievalPhase and executeRetrieve fails", async () => {
      const settingsSchema = schema((s) =>
        s.addTable("settings", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("key", "string")
            .addColumn("value", "string")
            .createIndex("unique_key", ["key"], { unique: true }),
        ),
      );

      // Create executor that throws "table does not exist" error
      const failingExecutor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => {
          throw new Error('relation "settings" does not exist');
        },
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
      };

      const factory = () =>
        createUnitOfWork(createMockCompiler(), failingExecutor, createMockDecoder());

      const deferred = Promise.withResolvers<string>();

      // Service method that awaits retrievalPhase (simulating settingsService.get())
      const getSettingValue = async (typedUow: TypedUnitOfWork<typeof settingsSchema>) => {
        const uow = typedUow.find("settings", (b) =>
          b.whereIndex("unique_key", (eb) => eb("key", "=", "version")),
        );
        const [results] = await uow.retrievalPhase;
        return results?.[0];
      };

      // Execute with executeRestrictedUnitOfWork
      try {
        await executeRestrictedUnitOfWork(
          async ({ forSchema, executeRetrieve }) => {
            const uow = forSchema(settingsSchema);

            const settingPromise = getSettingValue(uow);

            // Execute retrieval - this will fail
            await executeRetrieve();

            // Won't reach here
            return await settingPromise;
          },
          {
            createUnitOfWork: factory,
            retryPolicy: new NoRetryPolicy(),
          },
        );
        expect.fail("Should have thrown an error");
      } catch (error) {
        // The error should be thrown directly (not wrapped) since it's not a concurrency conflict
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('relation "settings" does not exist');
        deferred.resolve((error as Error).message);
      }

      // Verify no unhandled rejection occurred
      // If the test completes without throwing, the promise rejection was properly handled
      expect(await deferred.promise).toContain('relation "settings" does not exist');
    });
  });

  describe("executeTxArray", () => {
    it("should execute multiple service promises and await them before mutations", async () => {
      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => ({
          success: true,
          createdInternalIds: [],
        }),
      };
      const decoder = createMockDecoder();

      let retrievalExecuted = false;
      let servicesResolved = false;

      const result = await executeTxArray(
        () => [
          Promise.resolve().then(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            servicesResolved = true;
            return { result1: "value1" };
          }),
          Promise.resolve().then(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return { result2: "value2" };
          }),
        ],
        {
          createUnitOfWork: () => {
            const uow = createUnitOfWork(compiler, executor, decoder);
            const originalExecuteRetrieve = uow.executeRetrieve.bind(uow);
            uow.executeRetrieve = async () => {
              retrievalExecuted = true;
              return originalExecuteRetrieve();
            };
            return uow;
          },
        },
      );

      expect(retrievalExecuted).toBe(true);
      expect(servicesResolved).toBe(true);
      expect(result).toEqual([{ result1: "value1" }, { result2: "value2" }]);
    });

    it("should retry on concurrency conflict", async () => {
      const compiler = createMockCompiler();
      let attemptCount = 0;
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => {
          attemptCount++;
          if (attemptCount < 2) {
            return { success: false };
          }
          return {
            success: true,
            createdInternalIds: [],
          };
        },
      };
      const decoder = createMockDecoder();

      const result = await executeTxArray(() => [Promise.resolve({ result: "value" })], {
        createUnitOfWork: () => createUnitOfWork(compiler, executor, decoder),
        retryPolicy: new ExponentialBackoffRetryPolicy({ maxRetries: 3, initialDelayMs: 1 }),
      });

      expect(attemptCount).toBe(2);
      expect(result).toEqual([{ result: "value" }]);
    });

    it("should throw if retries exhausted", async () => {
      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => ({ success: false }),
      };
      const decoder = createMockDecoder();

      await expect(
        executeTxArray(() => [Promise.resolve({ result: "value" })], {
          createUnitOfWork: () => createUnitOfWork(compiler, executor, decoder),
          retryPolicy: new NoRetryPolicy(),
        }),
      ).rejects.toThrow("optimistic concurrency conflict");
    });
  });

  describe("executeTxCallbacks", () => {
    it("should execute retrieve and mutate callbacks in order", async () => {
      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => ({
          success: true,
          createdInternalIds: [],
        }),
      };
      const decoder = createMockDecoder();

      const executionOrder: string[] = [];

      const result = await executeTxCallbacks(
        {
          retrieve: ({ forSchema }) => {
            executionOrder.push("retrieve");
            const uow = forSchema(testSchema);
            uow.find("users", (b) => b.whereIndex("idx_email"));
            return { servicePromise: Promise.resolve({ value: "result" }) };
          },
          mutate: ({ forSchema }, { servicePromise }) => {
            executionOrder.push("mutate");
            const uow = forSchema(testSchema);
            uow.create("users", { email: "test@example.com", name: "Test", balance: 0 });
            return servicePromise;
          },
        },
        {
          createUnitOfWork: () => createUnitOfWork(compiler, executor, decoder),
        },
      );

      expect(executionOrder).toEqual(["retrieve", "mutate"]);
      expect(result).toEqual({ value: "result" });
    });

    it("should handle retrieve-only transactions", async () => {
      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [
          [
            {
              id: FragnoId.fromExternal("1", 1),
              email: "test@example.com",
              name: "Test",
              balance: 0,
            },
          ],
        ],
        executeMutationPhase: async () => ({
          success: true,
          createdInternalIds: [],
        }),
      };
      const decoder = createMockDecoder();

      const result = await executeTxCallbacks(
        {
          retrieve: ({ forSchema }) => {
            const uow = forSchema(testSchema);
            uow.find("users", (b) => b.whereIndex("idx_email"));
            return { users: [] };
          },
        },
        {
          createUnitOfWork: () => createUnitOfWork(compiler, executor, decoder),
        },
      );

      expect(result).toEqual({ users: [] });
    });

    it("should handle mutate-only transactions", async () => {
      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => ({
          success: true,
          createdInternalIds: [BigInt(1)],
        }),
      };
      const decoder = createMockDecoder();

      const result = await executeTxCallbacks(
        {
          mutate: ({ forSchema }) => {
            const uow = forSchema(testSchema);
            uow.create("users", { email: "test@example.com", name: "Test", balance: 0 });
            return { created: true };
          },
        },
        {
          createUnitOfWork: () => createUnitOfWork(compiler, executor, decoder),
        },
      );

      expect(result).toEqual({ created: true });
    });

    it("should await promises returned from mutate callback", async () => {
      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => ({
          success: true,
          createdInternalIds: [],
        }),
      };
      const decoder = createMockDecoder();

      const result = await executeTxCallbacks(
        {
          mutate: () => {
            return Promise.resolve({ value: "async result" });
          },
        },
        {
          createUnitOfWork: () => createUnitOfWork(compiler, executor, decoder),
        },
      );

      expect(result).toEqual({ value: "async result" });
    });

    it("should retry on concurrency conflict", async () => {
      const compiler = createMockCompiler();
      let attemptCount = 0;
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => {
          attemptCount++;
          if (attemptCount < 2) {
            return { success: false };
          }
          return {
            success: true,
            createdInternalIds: [],
          };
        },
      };
      const decoder = createMockDecoder();

      const result = await executeTxCallbacks(
        {
          mutate: () => ({ value: "result" }),
        },
        {
          createUnitOfWork: () => createUnitOfWork(compiler, executor, decoder),
          retryPolicy: new ExponentialBackoffRetryPolicy({ maxRetries: 3, initialDelayMs: 1 }),
        },
      );

      expect(attemptCount).toBe(2);
      expect(result).toEqual({ value: "result" });
    });
  });

  describe("executeServiceTx", () => {
    it("should execute service transaction with retrieve and mutate", async () => {
      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [
          [
            {
              id: FragnoId.fromExternal("1", 1),
              email: "test@example.com",
              name: "Test",
              balance: 100,
            },
          ],
        ],
        executeMutationPhase: async () => ({
          success: true,
          createdInternalIds: [],
        }),
      };
      const decoder = createMockDecoder();

      const baseUow = createUnitOfWork(compiler, executor, decoder);
      const restrictedUow = baseUow.restrict();

      // Start service tx
      const servicePromise = executeServiceTx(
        testSchema,
        {
          retrieve: (uow) => {
            return uow.findFirst("users", (b) => b.whereIndex("idx_email"));
          },
          mutate: async (uow, [user]) => {
            if (!user) {
              return { ok: false };
            }
            await new Promise((resolve) => setTimeout(resolve, 10)); // Async work
            uow.update("users", user.id, (b) => b.set({ balance: user.balance - 10 }));
            return { ok: true, newBalance: user.balance - 10 };
          },
        },
        restrictedUow,
      );

      // Simulate handler executing phases concurrently with service
      // Yield to let service start awaiting retrievalPhase
      await new Promise((resolve) => setImmediate(resolve));

      // Execute retrieve phase
      await baseUow.executeRetrieve();

      // Wait for service mutate callback to schedule mutations
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Execute mutation phase
      await baseUow.executeMutations();

      // Wait for service to complete
      const serviceResult = await servicePromise;
      expect(serviceResult).toEqual({ ok: true, newBalance: 90 });
    });

    it("should handle async mutate callback", async () => {
      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [[]],
        executeMutationPhase: async () => ({
          success: true,
          createdInternalIds: [BigInt(1)],
        }),
      };
      const decoder = createMockDecoder();

      const baseUow = createUnitOfWork(compiler, executor, decoder);
      const restrictedUow = baseUow.restrict();

      // Simulate handler executing phases concurrently with service
      const handlerSimulation = (async () => {
        // Yield to let service start
        await Promise.resolve();
        // Execute retrieve phase
        await baseUow.executeRetrieve();
        // Wait for service mutate callback to schedule mutations
        await new Promise((resolve) => setTimeout(resolve, 20));
        // Execute mutation phase
        await baseUow.executeMutations();
      })();

      // Start service tx
      const servicePromise = executeServiceTx(
        testSchema,
        {
          retrieve: (uow) => {
            return uow.find("users", (b) => b.whereIndex("idx_email"));
          },
          mutate: async (uow) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            uow.create("users", { email: "new@example.com", name: "New", balance: 0 });
            return { created: true };
          },
        },
        restrictedUow,
      );

      // Wait for both handler and service to complete
      await Promise.all([handlerSimulation, servicePromise]);

      const serviceResult = await servicePromise;
      expect(serviceResult).toEqual({ created: true });
    });

    it("should prevent anti-pattern: service async work completes before mutations execute", async () => {
      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [[]],
        executeMutationPhase: async () => ({
          success: true,
          createdInternalIds: [BigInt(1)],
        }),
      };
      const decoder = createMockDecoder();

      const baseUow = createUnitOfWork(compiler, executor, decoder);
      const restrictedUow = baseUow.restrict();

      let asyncWorkCompleted = false;
      let mutationScheduled = false;

      // Simulate handler executing phases concurrently with service
      const handlerSimulation = (async () => {
        // Yield to let service start
        await Promise.resolve();
        // Execute retrieve phase
        await baseUow.executeRetrieve();
        // Wait for service mutate callback to schedule mutations (including async work)
        await new Promise((resolve) => setTimeout(resolve, 30));
        // Execute mutation phase
        await baseUow.executeMutations();
      })();

      // Start service tx
      const servicePromise = executeServiceTx(
        testSchema,
        {
          retrieve: (uow) => {
            return uow.find("users", (b) => b.whereIndex("idx_email"));
          },
          mutate: async (uow) => {
            // Simulate async work (like hashing backup codes)
            await new Promise((resolve) => setTimeout(resolve, 20));
            asyncWorkCompleted = true;

            // Schedule mutation
            uow.create("users", { email: "test@example.com", name: "Test", balance: 0 });
            mutationScheduled = true;
            return { success: true };
          },
        },
        restrictedUow,
      );

      // Wait for both handler and service to complete
      await Promise.all([handlerSimulation, servicePromise]);

      expect(asyncWorkCompleted).toBe(true);
      expect(mutationScheduled).toBe(true);
    });
  });

  describe("executeTxArray with executeServiceTx", () => {
    it("should execute a single service promise created with executeServiceTx", async () => {
      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [
          [
            {
              id: FragnoId.fromExternal("1", 1),
              email: "user1@example.com",
              name: "User 1",
              balance: 100,
            },
          ],
        ],
        executeMutationPhase: async () => ({
          success: true,
          createdInternalIds: [],
        }),
      };
      const decoder = createMockDecoder();

      let currentUow: IUnitOfWork | null = null;

      // Execute the service promise using executeTxArray
      const result = await executeTxArray(
        () => [
          executeServiceTx(
            testSchema,
            {
              retrieve: (uow) => {
                return uow.findFirst("users", (b) => b.whereIndex("idx_email"));
              },
              mutate: async (uow, [user]) => {
                if (!user) {
                  return { ok: false };
                }
                // simulate async work
                await new Promise((resolve) => setTimeout(resolve, 10));

                uow.update("users", user.id, (b) => b.set({ balance: user.balance + 50 }));
                return { ok: true, newBalance: user.balance + 50 };
              },
            },
            currentUow!,
          ),
        ],
        {
          createUnitOfWork: () => {
            currentUow = createUnitOfWork(compiler, executor, decoder);
            return currentUow;
          },
        },
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ ok: true, newBalance: 150 });
    });

    it("should retry and eventually succeed when mutations fail on first attempts", async () => {
      const compiler = createMockCompiler();
      let executionAttemptCount = 0;
      let factoryCallCount = 0;

      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [
          [
            {
              id: FragnoId.fromExternal("1", 1),
              email: "user1@example.com",
              name: "User 1",
              balance: 100,
            },
          ],
        ],
        executeMutationPhase: async () => {
          executionAttemptCount++;
          // Fail on first 2 attempts, succeed on 3rd
          if (executionAttemptCount < 3) {
            return { success: false };
          }
          return {
            success: true,
            createdInternalIds: [],
          };
        },
      };
      const decoder = createMockDecoder();

      let currentUow: IUnitOfWork | null = null;

      const result = await executeTxArray(
        () => {
          factoryCallCount++;
          return [
            executeServiceTx(
              testSchema,
              {
                retrieve: (uow) => {
                  return uow.findFirst("users", (b) => b.whereIndex("idx_email"));
                },
                mutate: async (uow, [user]) => {
                  if (!user) {
                    return { ok: false };
                  }
                  // simulate async work
                  await new Promise((resolve) => setTimeout(resolve, 10));

                  uow.update("users", user.id, (b) => b.set({ balance: user.balance + 50 }));
                  return { ok: true, newBalance: user.balance + 50, attempt: factoryCallCount };
                },
              },
              currentUow!,
            ),
          ];
        },
        {
          createUnitOfWork: () => {
            currentUow = createUnitOfWork(compiler, executor, decoder);
            return currentUow;
          },
          retryPolicy: new ExponentialBackoffRetryPolicy({ maxRetries: 3, initialDelayMs: 1 }),
        },
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ ok: true, newBalance: 150, attempt: 3 });
      expect(factoryCallCount).toBe(3); // Factory called 3 times (once per attempt)
      expect(executionAttemptCount).toBe(3); // 3 execution attempts total
    });
  });
});
