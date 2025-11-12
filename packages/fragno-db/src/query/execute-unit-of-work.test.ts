import { describe, it, expect, vi, assert } from "vitest";
import { schema, idColumn, FragnoId } from "../schema/create";
import { UnitOfWork, type UOWCompiler, type UOWDecoder, type UOWExecutor } from "./unit-of-work";
import { executeUnitOfWork } from "./execute-unit-of-work";
import {
  ExponentialBackoffRetryPolicy,
  LinearBackoffRetryPolicy,
  NoRetryPolicy,
} from "./retry-policy";

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

// Mock compiler that returns null for all operations
function createMockCompiler(): UOWCompiler<unknown> {
  return {
    compileRetrievalOperation: () => null,
    compileMutationOperation: () => null,
  };
}

// Mock decoder that returns raw results as-is
function createMockDecoder(): UOWDecoder {
  return (rawResults) => rawResults;
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

    return new UnitOfWork(testSchema, createMockCompiler(), executor, createMockDecoder());
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
});
