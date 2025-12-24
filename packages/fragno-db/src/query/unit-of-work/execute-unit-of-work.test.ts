import { describe, it, expect, expectTypeOf } from "vitest";
import { schema, idColumn, FragnoId } from "../../schema/create";
import {
  createUnitOfWork,
  type IUnitOfWork,
  type UOWCompiler,
  type UOWDecoder,
  type UOWExecutor,
} from "./unit-of-work";
import {
  createServiceTx,
  executeTx,
  isTxResult,
  ConcurrencyConflictError,
} from "./execute-unit-of-work";
import {
  ExponentialBackoffRetryPolicy,
  LinearBackoffRetryPolicy,
  NoRetryPolicy,
} from "./retry-policy";
import type { AwaitedPromisesInObject, TxResult } from "./execute-unit-of-work";

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

describe("Unified Tx API", () => {
  describe("isTxResult", () => {
    it("should return true for TxResult objects", () => {
      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
      };
      const decoder = createMockDecoder();
      const baseUow = createUnitOfWork(compiler, executor, decoder);

      const txResult = createServiceTx(
        testSchema,
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("idx_email")),
        },
        baseUow,
      );

      expect(isTxResult(txResult)).toBe(true);
    });

    it("should return false for non-TxResult objects", () => {
      expect(isTxResult(null)).toBe(false);
      expect(isTxResult(undefined)).toBe(false);
      expect(isTxResult({})).toBe(false);
      expect(isTxResult({ _internal: {} })).toBe(false);
      expect(isTxResult(Promise.resolve())).toBe(false);
    });
  });

  describe("createServiceTx", () => {
    it("should create a TxResult with retrieve callback", () => {
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
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
      };
      const decoder = createMockDecoder();
      const baseUow = createUnitOfWork(compiler, executor, decoder);

      const txResult = createServiceTx(
        testSchema,
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("idx_email")),
        },
        baseUow,
      );

      expect(isTxResult(txResult)).toBe(true);
      expect(txResult._internal.schema).toBe(testSchema);
      expect(txResult._internal.callbacks.retrieve).toBeDefined();
    });

    it("should create a TxResult with retrieveSuccess callback", () => {
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
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
      };
      const decoder = createMockDecoder();
      const baseUow = createUnitOfWork(compiler, executor, decoder);

      const txResult = createServiceTx(
        testSchema,
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("idx_email")),
          retrieveSuccess: ([users]) => users[0] ?? null,
        },
        baseUow,
      );

      expect(isTxResult(txResult)).toBe(true);
      expect(txResult._internal.callbacks.retrieveSuccess).toBeDefined();
    });

    it("should create a TxResult with deps", () => {
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
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
      };
      const decoder = createMockDecoder();
      const baseUow = createUnitOfWork(compiler, executor, decoder);

      // Create a dependency TxResult
      const depTxResult = createServiceTx(
        testSchema,
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("idx_email")),
          retrieveSuccess: ([users]) => users[0] ?? null,
        },
        baseUow,
      );

      // Create a TxResult that depends on it
      const txResult = createServiceTx(
        testSchema,
        {
          deps: () => [depTxResult],
          mutate: ({ uow, depsRetrieveResult: [user] }) => {
            if (!user) {
              throw new Error("User not found");
            }
            return uow.create("users", { email: "new@example.com", name: "New", balance: 0 });
          },
        },
        baseUow,
      );

      expect(isTxResult(txResult)).toBe(true);
      expect(txResult._internal.deps).toHaveLength(1);
    });

    it("should type mutateResult as non-undefined when success AND mutate are provided", () => {
      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
      };
      const decoder = createMockDecoder();
      const baseUow = createUnitOfWork(compiler, executor, decoder);

      // When BOTH mutate AND success are provided, mutateResult should NOT be undefined
      createServiceTx(
        testSchema,
        {
          mutate: ({ uow }) => {
            uow.create("users", { email: "test@example.com", name: "Test", balance: 0 });
            return { created: true as const, code: "ABC123" };
          },
          success: ({ mutateResult }) => {
            // Key type assertion: mutateResult is NOT undefined when mutate callback IS provided
            expectTypeOf(mutateResult).toEqualTypeOf<{ created: true; code: string }>();
            // Should be able to access properties without null check
            return { success: true, code: mutateResult.code };
          },
        },
        baseUow,
      );
    });

    it("should type mutateResult as undefined when success is provided but mutate is NOT", () => {
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
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
      };
      const decoder = createMockDecoder();
      const baseUow = createUnitOfWork(compiler, executor, decoder);

      // When success is provided but mutate is NOT, mutateResult should be undefined
      createServiceTx(
        testSchema,
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("idx_email")),
          retrieveSuccess: ([users]) => users[0] ?? null,
          // NO mutate callback
          success: ({ mutateResult, retrieveResult }) => {
            // Key type assertion: mutateResult IS undefined when no mutate callback
            expectTypeOf(mutateResult).toEqualTypeOf<undefined>();
            // retrieveResult should still be properly typed (can be null from ?? null)
            if (retrieveResult !== null) {
              expectTypeOf(retrieveResult.email).toEqualTypeOf<string>();
            }
            return { user: retrieveResult };
          },
        },
        baseUow,
      );
    });

    it("should type retrieveResult as TRetrieveResults when retrieve is provided but retrieveSuccess is NOT", () => {
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
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
      };
      const decoder = createMockDecoder();
      const baseUow = createUnitOfWork(compiler, executor, decoder);

      // When retrieve IS provided but retrieveSuccess is NOT, retrieveResult should be TRetrieveResults
      // (the raw array from the retrieve callback), NOT unknown
      createServiceTx(
        testSchema,
        {
          retrieve: (uow) => uow.find("users", (b) => b.whereIndex("idx_email")),
          // NO retrieveSuccess callback - this is the key scenario
          mutate: ({ uow, retrieveResult }) => {
            // Key type assertion: retrieveResult should be the raw array type, NOT unknown
            // The retrieve callback returns TypedUnitOfWork with [users[]] as the results type
            expectTypeOf(retrieveResult).toEqualTypeOf<
              [{ id: FragnoId; email: string; name: string; balance: number }[]]
            >();

            // Should be able to access the array without type errors
            const users = retrieveResult[0];
            expectTypeOf(users).toEqualTypeOf<
              { id: FragnoId; email: string; name: string; balance: number }[]
            >();

            if (users.length > 0) {
              const user = users[0];
              uow.update("users", user.id, (b) => b.set({ balance: user.balance + 100 }));
            }
            return { processed: true };
          },
        },
        baseUow,
      );
    });
  });

  describe("executeTx", () => {
    it("should execute a simple mutate-only transaction", async () => {
      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [BigInt(1)] }),
      };
      const decoder = createMockDecoder();

      const result = await executeTx(
        {
          mutate: ({ forSchema }) => {
            const userId = forSchema(testSchema).create("users", {
              email: "test@example.com",
              name: "Test",
              balance: 100,
            });
            return { userId };
          },
        },
        {
          createUnitOfWork: () => createUnitOfWork(compiler, executor, decoder),
        },
      );

      expect(result.userId).toBeInstanceOf(FragnoId);
    });

    it("should execute a transaction with deps as retrieve source", async () => {
      const compiler = createMockCompiler();
      const mockUser = {
        id: FragnoId.fromExternal("1", 1),
        email: "test@example.com",
        name: "Test",
        balance: 100,
      };
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [[mockUser]],
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
      };
      const decoder = createMockDecoder();

      let currentUow: IUnitOfWork | null = null;

      // Service that retrieves
      const getUserById = () => {
        return createServiceTx(
          testSchema,
          {
            retrieve: (uow) => uow.find("users", (b) => b.whereIndex("idx_email")),
            retrieveSuccess: ([users]) => users[0] ?? null,
          },
          currentUow!,
        );
      };

      const result = await executeTx(
        {
          deps: () => [getUserById()],
          success: ({ depsResult: [user] }) => user,
        },
        {
          createUnitOfWork: () => {
            currentUow = createUnitOfWork(compiler, executor, decoder);
            return currentUow;
          },
        },
      );

      expect(result).toEqual(mockUser);
    });

    it("should execute a transaction with mutate callback using deps", async () => {
      const compiler = createMockCompiler();
      const mockUser = {
        id: FragnoId.fromExternal("1", 1),
        email: "test@example.com",
        name: "Test",
        balance: 100,
      };
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [[mockUser]],
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [BigInt(2)] }),
      };
      const decoder = createMockDecoder();

      let currentUow: IUnitOfWork | null = null;

      // Service that retrieves
      const getUserById = () => {
        return createServiceTx(
          testSchema,
          {
            retrieve: (uow) => uow.find("users", (b) => b.whereIndex("idx_email")),
            retrieveSuccess: ([users]) => users[0] ?? null,
          },
          currentUow!,
        );
      };

      const result = await executeTx(
        {
          deps: () => [getUserById()],
          mutate: ({ forSchema, depsRetrieveResult: [user] }) => {
            if (!user) {
              return { ok: false as const };
            }
            const newUserId = forSchema(testSchema).create("users", {
              email: "new@example.com",
              name: "New User",
              balance: 0,
            });
            return { ok: true as const, newUserId };
          },
        },
        {
          createUnitOfWork: () => {
            currentUow = createUnitOfWork(compiler, executor, decoder);
            return currentUow;
          },
        },
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.newUserId).toBeInstanceOf(FragnoId);
      }
    });

    it("should execute a transaction with success callback", async () => {
      const compiler = createMockCompiler();
      const mockUser = {
        id: FragnoId.fromExternal("1", 1),
        email: "test@example.com",
        name: "Test",
        balance: 100,
      };
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [[mockUser]],
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [BigInt(2)] }),
      };
      const decoder = createMockDecoder();

      let currentUow: IUnitOfWork | null = null;

      // Service that retrieves
      const getUserById = () => {
        return createServiceTx(
          testSchema,
          {
            retrieve: (uow) => uow.find("users", (b) => b.whereIndex("idx_email")),
            retrieveSuccess: ([users]) => users[0] ?? null,
          },
          currentUow!,
        );
      };

      const result = await executeTx(
        {
          deps: () => [getUserById()],
          mutate: ({ forSchema, depsRetrieveResult: [user] }) => {
            if (!user) {
              return { created: false as const };
            }
            const newUserId = forSchema(testSchema).create("users", {
              email: "new@example.com",
              name: "New User",
              balance: 0,
            });
            return { created: true as const, newUserId };
          },
          success: ({ depsRetrieveResult: [user], mutateResult }) => {
            return {
              originalUser: user,
              mutationResult: mutateResult,
              summary: "Transaction completed",
            };
          },
        },
        {
          createUnitOfWork: () => {
            currentUow = createUnitOfWork(compiler, executor, decoder);
            return currentUow;
          },
        },
      );

      expect(result.summary).toBe("Transaction completed");
      expect(result.originalUser).toEqual(mockUser);
      expect(result.mutationResult?.created).toBe(true);
    });

    it("should execute a transaction with deps (service composition)", async () => {
      const compiler = createMockCompiler();
      const mockUser = {
        id: FragnoId.fromExternal("1", 1),
        email: "test@example.com",
        name: "Test",
        balance: 100,
      };
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [[mockUser]],
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [BigInt(2)] }),
      };
      const decoder = createMockDecoder();

      let currentUow: IUnitOfWork | null = null;

      // Simulate a service method that returns a TxResult
      const getUserById = (userId: string) => {
        return createServiceTx(
          testSchema,
          {
            retrieve: (uow) =>
              uow.find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId))),
            retrieveSuccess: ([users]) => users[0] ?? null,
          },
          currentUow!,
        );
      };

      const result = await executeTx(
        {
          deps: () => [getUserById("1")],
          mutate: ({ forSchema, depsRetrieveResult: [user] }) => {
            if (!user) {
              return { ok: false as const };
            }
            const orderId = forSchema(testSchema).create("users", {
              email: "order@example.com",
              name: "Order",
              balance: 0,
            });
            return { ok: true as const, orderId, forUser: user.email };
          },
        },
        {
          createUnitOfWork: () => {
            currentUow = createUnitOfWork(compiler, executor, decoder);
            return currentUow;
          },
        },
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.forUser).toBe("test@example.com");
        expect(result.orderId).toBeInstanceOf(FragnoId);
      }
    });

    it("should type check deps with undefined (optional service pattern)", async () => {
      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [BigInt(1)] }),
      };
      const decoder = createMockDecoder();

      // Simulate optional service pattern: optionalService?.method()
      // When optionalService is undefined, this evaluates to undefined
      // Use type assertion to prevent TypeScript from narrowing to literal undefined
      const optionalService = undefined as
        | { getUser: () => TxResult<{ name: string }, { name: string }> }
        | undefined;

      // This test demonstrates that deps can contain TxResult | undefined
      // This is useful for optional service patterns like: optionalService?.method()
      const result = await executeTx(
        {
          // The key: deps array CAN contain undefined when optionalService is undefined
          // This pattern is common when using optional services: serviceDeps.otp?.generateOTP(userId)
          deps: () => [optionalService?.getUser()],
          mutate: ({ forSchema, depsRetrieveResult: [maybeUser] }) => {
            // maybeUser is typed as { name: string } | undefined
            // This demonstrates the optional chaining pattern works correctly
            expectTypeOf(maybeUser).toEqualTypeOf<{ name: string } | undefined>();
            if (!maybeUser) {
              const userId = forSchema(testSchema).create("users", {
                email: "fallback@example.com",
                name: "Fallback User",
                balance: 0,
              });
              return { hadUser: false as const, userId };
            }
            return { hadUser: true as const, userName: maybeUser.name };
          },
        },
        {
          createUnitOfWork: () => createUnitOfWork(compiler, executor, decoder),
        },
      );

      // Since optionalService was undefined, maybeUser was undefined, so we hit the fallback path
      expect(result.hadUser).toBe(false);
      if (!result.hadUser) {
        expect(result.userId).toBeInstanceOf(FragnoId);
      }
    });

    it("should handle deps with mix of TxResult and undefined", async () => {
      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [BigInt(1)] }),
      };
      const decoder = createMockDecoder();

      let currentUow: IUnitOfWork | null = null;

      // Type for the created data returned by the defined service
      type CreatedData = { userId: FragnoId; generatedCode: string };
      // Type for the extra data that would be returned by the optional service
      type ExtraData = { extraCode: string; timestamp: number };

      // One defined service with mutation that returns data
      const definedService = {
        createUserAndReturnCode: (): TxResult<CreatedData, CreatedData> =>
          createServiceTx(
            testSchema,
            {
              // This service has a MUTATION (not just retrieve)
              mutate: ({ uow }): CreatedData => {
                const userId = uow.create("users", {
                  email: "created@example.com",
                  name: "Created User",
                  balance: 0,
                });
                // Return arbitrary data from the mutation
                return { userId, generatedCode: "ABC123" };
              },
            },
            currentUow!,
          ),
      };

      // Optional service that would also return mutation data
      const optionalService = undefined as
        | {
            generateExtra: () => TxResult<ExtraData, ExtraData>;
          }
        | undefined;

      const result = await executeTx(
        {
          // Mix of defined TxResult and undefined (from optional service)
          deps: () =>
            [definedService.createUserAndReturnCode(), optionalService?.generateExtra()] as const,
          mutate: ({ forSchema, depsRetrieveResult }) => {
            // depsRetrieveResult contains the mutation results from deps
            // (since deps have no retrieveSuccess, the mutate result becomes the retrieve result for dependents)
            const [createdData, maybeExtra] = depsRetrieveResult;

            // Type checks: createdData should have userId and generatedCode
            // maybeExtra should be ExtraData | undefined
            expectTypeOf(createdData).toEqualTypeOf<CreatedData>();
            expectTypeOf(maybeExtra).toEqualTypeOf<ExtraData | undefined>();

            forSchema(testSchema).create("users", {
              email: "handler@example.com",
              name: "Handler User",
              balance: 0,
            });

            return {
              depCode: createdData.generatedCode,
              hadExtra: maybeExtra !== undefined,
            };
          },
          success: ({ depsResult, depsRetrieveResult, mutateResult }) => {
            // Verify depsResult types - these are the FINAL results from deps
            const [finalCreatedData, maybeFinalExtra] = depsResult;

            // Type check: depsResult should have same structure
            // The final result is CreatedData (since there's no success callback on the dep)
            expectTypeOf(finalCreatedData).toEqualTypeOf<CreatedData>();
            expectTypeOf(maybeFinalExtra).toEqualTypeOf<ExtraData | undefined>();

            // depsRetrieveResult should still be accessible in success
            const [_retrieveData, maybeRetrieveExtra] = depsRetrieveResult;
            expectTypeOf(maybeRetrieveExtra).toEqualTypeOf<ExtraData | undefined>();

            return {
              ...mutateResult,
              finalDepUserId: finalCreatedData.userId,
              finalDepCode: finalCreatedData.generatedCode,
              extraWasUndefined: maybeFinalExtra === undefined,
            };
          },
        },
        {
          createUnitOfWork: () => {
            currentUow = createUnitOfWork(compiler, executor, decoder);
            return currentUow;
          },
        },
      );

      // Verify runtime behavior
      expect(result.depCode).toBe("ABC123");
      expect(result.hadExtra).toBe(false);
      expect(result.finalDepCode).toBe("ABC123");
      expect(result.extraWasUndefined).toBe(true);
      expect(result.finalDepUserId).toBeInstanceOf(FragnoId);
    });

    it("should retry on concurrency conflict", async () => {
      const compiler = createMockCompiler();
      let mutationAttempts = 0;
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => {
          mutationAttempts++;
          if (mutationAttempts < 3) {
            return { success: false };
          }
          return { success: true, createdInternalIds: [] };
        },
      };
      const decoder = createMockDecoder();

      const result = await executeTx(
        {
          mutate: ({ forSchema }) => {
            forSchema(testSchema).create("users", {
              email: "test@example.com",
              name: "Test",
              balance: 0,
            });
            return { createdAt: Date.now() };
          },
        },
        {
          createUnitOfWork: () => createUnitOfWork(compiler, executor, decoder),
          retryPolicy: new ExponentialBackoffRetryPolicy({ maxRetries: 5, initialDelayMs: 1 }),
        },
      );

      // Verify we retried the correct number of times
      expect(mutationAttempts).toBe(3);
      // Verify we got a result
      expect(result.createdAt).toBeGreaterThan(0);
    });

    it("should throw ConcurrencyConflictError when retries are exhausted", async () => {
      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => ({ success: false }),
      };
      const decoder = createMockDecoder();

      await expect(
        executeTx(
          {
            mutate: () => ({ done: true }),
          },
          {
            createUnitOfWork: () => createUnitOfWork(compiler, executor, decoder),
            retryPolicy: new NoRetryPolicy(),
          },
        ),
      ).rejects.toThrow(ConcurrencyConflictError);
    });

    it("should abort when signal is aborted", async () => {
      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
      };
      const decoder = createMockDecoder();

      const controller = new AbortController();
      controller.abort();

      await expect(
        executeTx(
          {
            mutate: () => ({ done: true }),
          },
          {
            createUnitOfWork: () => createUnitOfWork(compiler, executor, decoder),
            signal: controller.signal,
          },
        ),
      ).rejects.toThrow("Transaction execution aborted");
    });

    it("should create fresh UOW on each retry attempt", async () => {
      const compiler = createMockCompiler();
      let callCount = 0;
      let mutationAttempts = 0;
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => {
          mutationAttempts++;
          if (mutationAttempts < 3) {
            return { success: false };
          }
          return { success: true, createdInternalIds: [] };
        },
      };
      const decoder = createMockDecoder();

      await executeTx(
        {
          mutate: ({ forSchema }) => {
            forSchema(testSchema).create("users", {
              email: "test@example.com",
              name: "Test",
              balance: 0,
            });
          },
        },
        {
          createUnitOfWork: () => {
            callCount++;
            return createUnitOfWork(compiler, executor, decoder);
          },
          retryPolicy: new LinearBackoffRetryPolicy({ maxRetries: 3, delayMs: 1 }),
        },
      );

      // Verify factory was called for each attempt (initial + 2 retries)
      expect(callCount).toBe(3);
    });

    it("should abort when signal is aborted during retry delay", async () => {
      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => ({ success: false }),
      };
      const decoder = createMockDecoder();

      const controller = new AbortController();

      // Abort after first attempt during retry delay
      setTimeout(() => controller.abort(), 50);

      await expect(
        executeTx(
          {
            mutate: () => ({ done: true }),
          },
          {
            createUnitOfWork: () => createUnitOfWork(compiler, executor, decoder),
            retryPolicy: new LinearBackoffRetryPolicy({ maxRetries: 5, delayMs: 100 }),
            signal: controller.signal,
          },
        ),
      ).rejects.toThrow("Transaction execution aborted");
    });

    it("should pass depsResult to success callback with final results", async () => {
      const compiler = createMockCompiler();
      const mockUser = {
        id: FragnoId.fromExternal("1", 1),
        email: "test@example.com",
        name: "Test",
        balance: 100,
      };
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [[mockUser]],
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [BigInt(2)] }),
      };
      const decoder = createMockDecoder();

      let currentUow: IUnitOfWork | null = null;

      // Service that retrieves and mutates
      const getUserAndUpdateBalance = (userId: string) => {
        return createServiceTx(
          testSchema,
          {
            retrieve: (uow) =>
              uow.find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId))),
            retrieveSuccess: ([users]) => users[0] ?? null,
            mutate: ({ uow, retrieveResult: user }) => {
              expect(user).toEqual(mockUser);
              expectTypeOf(user).toEqualTypeOf<typeof mockUser>();
              if (!user) {
                return { updated: false as const };
              }
              uow.update("users", user.id, (b) => b.set({ balance: user.balance + 100 }).check());
              return { updated: true as const, newBalance: user.balance + 100 };
            },
          },
          currentUow!,
        );
      };

      const result = await executeTx(
        {
          deps: () => [getUserAndUpdateBalance("1")],
          success: ({ depsResult: [depResult], depsRetrieveResult: [depRetrieveResult] }) => {
            expect(depResult).toEqual({
              updated: true,
              newBalance: 200,
            });

            expect(depRetrieveResult).toEqual(mockUser);

            const dep = depResult;
            return {
              depUpdated: dep.updated,
              depNewBalance: dep.updated ? dep.newBalance : null,
            };
          },
        },
        {
          createUnitOfWork: () => {
            currentUow = createUnitOfWork(compiler, executor, decoder);
            return currentUow;
          },
        },
      );

      expect(result.depUpdated).toBe(true);
      expect(result.depNewBalance).toBe(200);
    });
  });

  describe("return type priority", () => {
    it("should return success result when success callback is provided", async () => {
      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
      };
      const decoder = createMockDecoder();

      const result = await executeTx(
        {
          retrieveSuccess: (ctx) => {
            expectTypeOf(ctx).toEqualTypeOf<unknown[]>();

            return "retrieveSuccess result" as const;
          },
          mutate: (ctx) => {
            expectTypeOf(ctx.retrieveResult).toEqualTypeOf<"retrieveSuccess result">();

            return "mutate result" as const;
          },
          success: (ctx) => {
            expectTypeOf(ctx.retrieveResult).toEqualTypeOf<"retrieveSuccess result">();
            // mutateResult is NOT | undefined because mutate callback IS provided
            expectTypeOf(ctx.mutateResult).toEqualTypeOf<"mutate result">();
            // depsResult and depsRetrieveResult are empty tuples since no deps callback
            expectTypeOf(ctx.depsResult).toEqualTypeOf<readonly []>();
            expectTypeOf(ctx.depsRetrieveResult).toEqualTypeOf<readonly []>();

            return "success result" as const;
          },
        },
        {
          createUnitOfWork: () => createUnitOfWork(compiler, executor, decoder),
        },
      );

      expect(result).toBe("success result");
    });

    it("should return mutate result when no success callback", async () => {
      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
      };
      const decoder = createMockDecoder();

      const result = await executeTx(
        {
          retrieveSuccess: () => "retrieveSuccess result",
          mutate: () => "mutate result",
        },
        {
          createUnitOfWork: () => createUnitOfWork(compiler, executor, decoder),
        },
      );

      expect(result).toBe("mutate result");
    });

    it("should return retrieveSuccess result when no mutate or success", async () => {
      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
      };
      const decoder = createMockDecoder();

      const result = await executeTx(
        {
          retrieveSuccess: () => "retrieveSuccess result",
        },
        {
          createUnitOfWork: () => createUnitOfWork(compiler, executor, decoder),
        },
      );

      expect(result).toBe("retrieveSuccess result");
    });

    it("should return deps final results when no local callbacks", async () => {
      const compiler = createMockCompiler();
      const mockUser = {
        id: FragnoId.fromExternal("1", 1),
        email: "test@example.com",
        name: "Test",
        balance: 100,
      };
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [[mockUser]],
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
      };
      const decoder = createMockDecoder();

      let currentUow: IUnitOfWork | null = null;

      // Service that just retrieves
      const getUser = () => {
        return createServiceTx(
          testSchema,
          {
            retrieve: (uow) => uow.find("users", (b) => b.whereIndex("idx_email")),
            retrieveSuccess: ([users]) => users[0] ?? null,
          },
          currentUow!,
        );
      };

      // executeTx with only deps - should return deps' final results
      const result = await executeTx(
        {
          deps: () => [getUser()],
        },
        {
          createUnitOfWork: () => {
            currentUow = createUnitOfWork(compiler, executor, decoder);
            return currentUow;
          },
        },
      );

      expect(result).toEqual([mockUser]);
    });
  });

  describe("depsRetrieveResult vs depsResult", () => {
    it("depsRetrieveResult in mutate should contain retrieveSuccess results", async () => {
      const compiler = createMockCompiler();
      const mockUser = {
        id: FragnoId.fromExternal("1", 1),
        email: "test@example.com",
        name: "Test",
        balance: 100,
      };
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [[mockUser]],
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
      };
      const decoder = createMockDecoder();

      let currentUow: IUnitOfWork | null = null;
      let capturedDepsRetrieveResult: unknown[] = [];

      const getUserById = () => {
        return createServiceTx(
          testSchema,
          {
            retrieve: (uow) => uow.find("users", (b) => b.whereIndex("idx_email")),
            // This retrieveSuccess transforms the result
            retrieveSuccess: ([users]) => ({ transformed: true, user: users[0] }),
          },
          currentUow!,
        );
      };

      await executeTx(
        {
          deps: () => [getUserById()],
          mutate: ({ depsRetrieveResult }) => {
            // Should receive the transformed (retrieveSuccess) result
            capturedDepsRetrieveResult = [...depsRetrieveResult];
            return { done: true };
          },
        },
        {
          createUnitOfWork: () => {
            currentUow = createUnitOfWork(compiler, executor, decoder);
            return currentUow;
          },
        },
      );

      expect(capturedDepsRetrieveResult[0]).toEqual({ transformed: true, user: mockUser });
    });

    it("depsResult in success should contain final (mutate) results", async () => {
      const compiler = createMockCompiler();
      const mockUser = {
        id: FragnoId.fromExternal("1", 1),
        email: "test@example.com",
        name: "Test",
        balance: 100,
      };
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [[mockUser]],
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
      };
      const decoder = createMockDecoder();

      let currentUow: IUnitOfWork | null = null;
      let capturedDepsResult: unknown[] = [];

      const getUserById = () => {
        return createServiceTx(
          testSchema,
          {
            retrieve: (uow) => uow.find("users", (b) => b.whereIndex("idx_email")),
            retrieveSuccess: ([users]) => users[0],
            // This mutate returns a different result
            mutate: ({ retrieveResult: user }) => ({ mutated: true, userId: user?.id }),
          },
          currentUow!,
        );
      };

      await executeTx(
        {
          deps: () => [getUserById()],
          success: ({ depsResult }) => {
            // Should receive the mutate result (final), not retrieveSuccess result
            capturedDepsResult = [...depsResult];
            return { done: true };
          },
        },
        {
          createUnitOfWork: () => {
            currentUow = createUnitOfWork(compiler, executor, decoder);
            return currentUow;
          },
        },
      );

      expect(capturedDepsResult[0]).toEqual({ mutated: true, userId: mockUser.id });
    });

    it("depsRetrieveResult in success should contain mutateResult for mutate-only deps (via processTxResultAfterMutate)", async () => {
      // This test exercises the buggy code path in processTxResultAfterMutate:
      // When a nested TxResult has a success callback and its dep is mutate-only,
      // the success callback should receive the mutateResult in depsRetrieveResult, NOT the empty array.
      //
      // The key is that the nested service itself (wrapperService) has a success callback,
      // so processTxResultAfterMutate is called for it.
      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => ({
          success: true,
          createdInternalIds: [BigInt(1)],
        }),
      };
      const decoder = createMockDecoder();

      let currentUow: IUnitOfWork | null = null;
      let capturedDepsRetrieveResultInNestedSuccess: unknown[] = [];

      // Mutate-only service - no retrieve or retrieveSuccess callbacks
      const createItem = () => {
        return createServiceTx(
          testSchema,
          {
            // NO retrieve or retrieveSuccess - this is a mutate-only dep
            mutate: ({ uow }) => {
              const itemId = uow.create("users", {
                email: "new-item@example.com",
                name: "New Item",
                balance: 0,
              });
              return { created: true, itemId };
            },
          },
          currentUow!,
        );
      };

      // Wrapper service that has a success callback and uses createItem as a dep
      // This forces processTxResultAfterMutate to be called for this TxResult
      const wrapperService = () => {
        return createServiceTx(
          testSchema,
          {
            deps: () => [createItem()] as const,
            // NO mutate callback - just pass through
            // The success callback is the key: it makes processTxResultAfterMutate get called
            success: ({ depsRetrieveResult, depsResult }) => {
              capturedDepsRetrieveResultInNestedSuccess = [...depsRetrieveResult];
              // depsResult should equal depsRetrieveResult since dep has no success callback
              expect(depsResult[0]).toEqual(depsRetrieveResult[0]);
              return { wrapped: true, innerResult: depsRetrieveResult[0] };
            },
          },
          currentUow!,
        );
      };

      const result = await executeTx(
        {
          deps: () => [wrapperService()] as const,
          success: ({ depsResult: [wrapperResult] }) => wrapperResult,
        },
        {
          createUnitOfWork: () => {
            currentUow = createUnitOfWork(compiler, executor, decoder);
            return currentUow;
          },
        },
      );

      // The wrapper service's success callback should have received the mutateResult, NOT empty array
      expect(capturedDepsRetrieveResultInNestedSuccess[0]).toEqual({
        created: true,
        itemId: expect.any(FragnoId),
      });
      // Verify it's not the empty array sentinel
      expect(capturedDepsRetrieveResultInNestedSuccess[0]).not.toEqual([]);

      // And the handler should get the wrapped result
      expect(result).toEqual({
        wrapped: true,
        innerResult: { created: true, itemId: expect.any(FragnoId) },
      });
    });
  });

  describe("nested TxResult deps (service composition)", () => {
    it("should collect nested deps in dependency order", async () => {
      // Simpler test to verify collectAllTxResults works correctly
      const compiler = createMockCompiler();
      const mockUser = {
        id: FragnoId.fromExternal("user-1", 1),
        email: "test@example.com",
        name: "Test User",
        balance: 100,
      };
      let retrievePhaseExecuted = false;
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => {
          retrievePhaseExecuted = true;
          return [[mockUser]];
        },
        executeMutationPhase: async () => ({
          success: true,
          createdInternalIds: [],
        }),
      };
      const decoder = createMockDecoder();

      let currentUow: IUnitOfWork | null = null;
      let getUserByIdCalled = false;
      let validateUserCalled = false;

      // Simple service that retrieves - no nested deps
      const getUserById = (userId: string) => {
        getUserByIdCalled = true;
        if (!currentUow) {
          throw new Error("currentUow is null in getUserById!");
        }
        return createServiceTx(
          testSchema,
          {
            retrieve: (uow) =>
              uow.find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId))),
            retrieveSuccess: ([users]) => users[0] ?? null,
          },
          currentUow,
        );
      };

      // Service with deps - depends on getUserById
      const validateUser = (userId: string) => {
        validateUserCalled = true;
        if (!currentUow) {
          throw new Error("currentUow is null in validateUser!");
        }
        return createServiceTx(
          testSchema,
          {
            deps: () => [getUserById(userId)] as const,
            // mutate callback receives depsRetrieveResult
            mutate: ({ depsRetrieveResult: [user] }) => {
              return { valid: user !== null, user };
            },
          },
          currentUow,
        );
      };

      // Handler calls executeTx with deps containing validateUser
      // This tests 2-level nesting: handler -> validateUser -> getUserById
      const result = await executeTx(
        {
          deps: () => [validateUser("user-1")] as const,
          success: ({ depsResult: [validationResult] }) => {
            return {
              isValid: validationResult.valid,
              userName: validationResult.user?.name,
            };
          },
        },
        {
          createUnitOfWork: () => {
            currentUow = createUnitOfWork(compiler, executor, decoder);
            return currentUow;
          },
        },
      );

      // Verify services were called
      expect(getUserByIdCalled).toBe(true);
      expect(validateUserCalled).toBe(true);
      expect(retrievePhaseExecuted).toBe(true);
      expect(result.isValid).toBe(true);
      expect(result.userName).toBe("Test User");
    }, 500);

    it("should handle a TxResult with deps that returns another TxResult", async () => {
      // This test reproduces the integration test scenario where:
      // - orderService.createOrderWithValidation has deps: () => [userService.getUserById(...)]
      // - handler has deps: () => [orderService.createOrderWithValidation(...)]

      const compiler = createMockCompiler();
      const mockUser = {
        id: FragnoId.fromExternal("user-1", 1),
        email: "test@example.com",
        name: "Test User",
        balance: 100,
      };
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [[mockUser]],
        executeMutationPhase: async () => ({
          success: true,
          createdInternalIds: [BigInt(1)],
        }),
      };
      const decoder = createMockDecoder();

      let currentUow: IUnitOfWork | null = null;

      // Simulates userService.getUserById - returns a TxResult that retrieves a user
      const getUserById = (userId: string) => {
        return createServiceTx(
          testSchema,
          {
            retrieve: (uow) =>
              uow.find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId))),
            retrieveSuccess: ([users]) => users[0] ?? null,
          },
          currentUow!,
        );
      };

      // Simulates orderService.createOrderWithValidation - has deps on getUserById
      const createOrderWithValidation = (userId: string, productName: string) => {
        return createServiceTx(
          testSchema,
          {
            // This deps returns another TxResult!
            deps: () => [getUserById(userId)] as const,
            mutate: ({ uow, depsRetrieveResult: [user] }) => {
              if (!user) {
                throw new Error("User not found");
              }
              // Create an order (simulated by creating a user for simplicity)
              const orderId = uow.create("users", {
                email: `order-${productName}@example.com`,
                name: productName,
                balance: 0,
              });
              return { orderId, forUser: user.email };
            },
          },
          currentUow!,
        );
      };

      // Handler calls executeTx with deps containing the order service
      const result = await executeTx(
        {
          deps: () => [createOrderWithValidation("user-1", "TypeScript Book")] as const,
          success: ({ depsResult: [orderResult] }) => {
            return {
              orderId: orderResult.orderId,
              forUser: orderResult.forUser,
              completed: true,
            };
          },
        },
        {
          createUnitOfWork: () => {
            currentUow = createUnitOfWork(compiler, executor, decoder);
            return currentUow;
          },
        },
      );

      expect(result.completed).toBe(true);
      expect(result.forUser).toBe("test@example.com");
      expect(result.orderId).toBeInstanceOf(FragnoId);
    }, 500); // Set 500ms timeout to catch deadlock

    it("should handle deeply nested TxResult deps (3 levels)", async () => {
      const compiler = createMockCompiler();
      const mockUser = {
        id: FragnoId.fromExternal("user-1", 1),
        email: "test@example.com",
        name: "Test User",
        balance: 100,
      };
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [[mockUser]],
        executeMutationPhase: async () => ({
          success: true,
          createdInternalIds: [BigInt(1)],
        }),
      };
      const decoder = createMockDecoder();

      let currentUow: IUnitOfWork | null = null;

      // Level 3: Basic user retrieval
      const getUserById = (userId: string) => {
        return createServiceTx(
          testSchema,
          {
            retrieve: (uow) =>
              uow.find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId))),
            retrieveSuccess: ([users]) => users[0] ?? null,
          },
          currentUow!,
        );
      };

      // Level 2: Depends on getUserById
      const validateUser = (userId: string) => {
        return createServiceTx(
          testSchema,
          {
            deps: () => [getUserById(userId)] as const,
            mutate: ({ depsRetrieveResult: [user] }) => {
              if (!user) {
                return { valid: false as const, reason: "User not found" };
              }
              return { valid: true as const, user };
            },
          },
          currentUow!,
        );
      };

      // Level 1: Depends on validateUser
      const createOrder = (userId: string, productName: string) => {
        return createServiceTx(
          testSchema,
          {
            deps: () => [validateUser(userId)] as const,
            mutate: ({ uow, depsRetrieveResult: [validation] }) => {
              if (!validation.valid) {
                throw new Error(validation.reason);
              }
              const orderId = uow.create("users", {
                email: `order-${productName}@example.com`,
                name: productName,
                balance: 0,
              });
              return { orderId, forUser: validation.user.email };
            },
          },
          currentUow!,
        );
      };

      // Handler: Depends on createOrder (3 levels deep)
      const result = await executeTx(
        {
          deps: () => [createOrder("user-1", "Advanced TypeScript")] as const,
          success: ({ depsResult: [orderResult] }) => ({
            orderId: orderResult.orderId,
            forUser: orderResult.forUser,
            completed: true,
          }),
        },
        {
          createUnitOfWork: () => {
            currentUow = createUnitOfWork(compiler, executor, decoder);
            return currentUow;
          },
        },
      );

      expect(result.completed).toBe(true);
      expect(result.forUser).toBe("test@example.com");
      expect(result.orderId).toBeInstanceOf(FragnoId);
    }, 500); // Set 500ms timeout to catch deadlock
  });

  describe("triggerHook in serviceTx", () => {
    it("should record triggered hooks on the base UOW when using createServiceTx with retrieve and mutate", async () => {
      const compiler = createMockCompiler();
      const mockUser = {
        id: FragnoId.fromExternal("user-1", 1),
        email: "test@example.com",
        name: "Test User",
        balance: 100,
      };
      // Return empty array to simulate no existing user, so the hook will be triggered
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [[]],
        executeMutationPhase: async () => ({
          success: true,
          createdInternalIds: [],
        }),
      };
      const decoder = createMockDecoder();

      let currentUow: IUnitOfWork | null = null;

      // Define hooks type for this test
      type TestHooks = {
        onSubscribe: (payload: { email: string }) => void;
      };

      // Service that retrieves a user and triggers a hook in mutate
      const subscribeUser = (email: string) => {
        return createServiceTx<
          typeof testSchema,
          [(typeof mockUser)[]],
          typeof mockUser | null,
          readonly [],
          { subscribed: boolean; email: string },
          TestHooks
        >(
          testSchema,
          {
            retrieve: (uow) =>
              uow.find("users", (b) => b.whereIndex("idx_email", (eb) => eb("email", "=", email))),
            retrieveSuccess: ([users]) => users[0] ?? null,
            mutate: ({ uow, retrieveResult: existingUser }) => {
              if (existingUser) {
                return { subscribed: false, email };
              }
              // Trigger hook when subscribing a new user
              uow.triggerHook("onSubscribe", { email });
              return { subscribed: true, email };
            },
          },
          currentUow!,
        );
      };

      // Execute the transaction
      await executeTx(
        {
          deps: () => [subscribeUser("new@example.com")] as const,
          success: ({ depsResult: [result] }) => result,
        },
        {
          createUnitOfWork: () => {
            currentUow = createUnitOfWork(compiler, executor, decoder);
            return currentUow;
          },
        },
      );

      // Verify that the hook was triggered and recorded on the base UOW
      const triggeredHooks = currentUow!.getTriggeredHooks();
      expect(triggeredHooks).toHaveLength(1);
      expect(triggeredHooks[0]).toMatchObject({
        hookName: "onSubscribe",
        payload: { email: "new@example.com" },
      });
    });

    it("should record triggered hooks when service has only retrieve (no retrieveSuccess) and mutate", async () => {
      const compiler = createMockCompiler();
      const mockUser = {
        id: FragnoId.fromExternal("user-1", 1),
        email: "test@example.com",
        name: "Test User",
        balance: 100,
      };
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [[mockUser]],
        executeMutationPhase: async () => ({
          success: true,
          createdInternalIds: [],
        }),
      };
      const decoder = createMockDecoder();

      let currentUow: IUnitOfWork | null = null;

      // Define hooks type for this test
      type TestHooks = {
        onUserUpdated: (payload: { userId: string }) => void;
      };

      // Service that uses raw retrieve results (no retrieveSuccess) and triggers hook
      const updateUser = (userId: string) => {
        return createServiceTx<
          typeof testSchema,
          [(typeof mockUser)[]],
          readonly [],
          { updated: boolean },
          TestHooks
        >(
          testSchema,
          {
            retrieve: (uow) =>
              uow.find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId))),
            // NO retrieveSuccess - mutate receives raw [users[]] array
            mutate: ({ uow, retrieveResult: [users] }) => {
              const user = users[0];
              if (!user) {
                return { updated: false };
              }
              uow.triggerHook("onUserUpdated", { userId: user.id.toString() });
              return { updated: true };
            },
          },
          currentUow!,
        );
      };

      await executeTx(
        {
          deps: () => [updateUser("user-1")] as const,
          success: ({ depsResult: [result] }) => result,
        },
        {
          createUnitOfWork: () => {
            currentUow = createUnitOfWork(compiler, executor, decoder);
            return currentUow;
          },
        },
      );

      // Verify hook was triggered
      const triggeredHooks = currentUow!.getTriggeredHooks();
      expect(triggeredHooks).toHaveLength(1);
      expect(triggeredHooks[0]).toMatchObject({
        hookName: "onUserUpdated",
        payload: { userId: expect.any(String) },
      });
    });
  });

  describe("error handling in createServiceTx", () => {
    it("should not cause unhandled rejection when retrieve callback throws synchronously in deps", async () => {
      // This test verifies that when a service's retrieve callback throws synchronously,
      // the error is properly propagated without causing an unhandled rejection warning.
      // Without the fix (adding retrievePhase.catch(() => {}) before rejecting and throwing),
      // this test would cause an "Unhandled Rejection" warning from Vitest.

      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => ({
          success: true,
          createdInternalIds: [],
        }),
      };
      const decoder = createMockDecoder();

      let currentUow: IUnitOfWork | null = null;

      const syncError = new Error("Retrieve callback threw synchronously");

      // Service that throws synchronously in retrieve callback
      const failingService = () => {
        return createServiceTx(
          testSchema,
          {
            retrieve: () => {
              throw syncError;
            },
          },
          currentUow!,
        );
      };

      // Execute with deps that contain the failing service
      // The error should be properly caught and re-thrown without unhandled rejection
      await expect(
        executeTx(
          {
            deps: () => [failingService()] as const,
            success: ({ depsResult: [result] }) => result,
          },
          {
            createUnitOfWork: () => {
              currentUow = createUnitOfWork(compiler, executor, decoder);
              return currentUow;
            },
          },
        ),
      ).rejects.toThrow("Retrieve callback threw synchronously");
    });

    it("should not cause unhandled rejection when deps callback throws synchronously", async () => {
      // This test verifies that when a service's deps callback throws synchronously,
      // the error is properly propagated without causing an unhandled rejection warning.

      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => ({
          success: true,
          createdInternalIds: [],
        }),
      };
      const decoder = createMockDecoder();

      let currentUow: IUnitOfWork | null = null;

      const syncError = new Error("Deps callback threw synchronously");

      // Service that throws synchronously in deps callback
      const failingService = () => {
        return createServiceTx(
          testSchema,
          {
            deps: () => {
              throw syncError;
            },
            mutate: () => ({ done: true }),
          },
          currentUow!,
        );
      };

      // Execute with deps that contain the failing service
      await expect(
        executeTx(
          {
            deps: () => [failingService()] as const,
            success: ({ depsResult: [result] }) => result,
          },
          {
            createUnitOfWork: () => {
              currentUow = createUnitOfWork(compiler, executor, decoder);
              return currentUow;
            },
          },
        ),
      ).rejects.toThrow("Deps callback threw synchronously");
    });
  });
});
