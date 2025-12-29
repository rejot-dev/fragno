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
  createServiceTxBuilder,
  createHandlerTxBuilder,
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

      const txResult = createServiceTxBuilder(testSchema, baseUow)
        .retrieve((uow) => uow.find("users", (b) => b.whereIndex("idx_email")))
        .build();

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

      const txResult = createServiceTxBuilder(testSchema, baseUow)
        .retrieve((uow) => uow.find("users", (b) => b.whereIndex("idx_email")))
        .build();

      expect(isTxResult(txResult)).toBe(true);
      expect(txResult._internal.schema).toBe(testSchema);
      expect(txResult._internal.callbacks.retrieve).toBeDefined();
    });

    it("should create a TxResult with transformRetrieve callback", () => {
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

      const txResult = createServiceTxBuilder(testSchema, baseUow)
        .retrieve((uow) => uow.find("users", (b) => b.whereIndex("idx_email")))
        .transformRetrieve(([users]) => users[0] ?? null)
        .build();

      expect(isTxResult(txResult)).toBe(true);
      expect(txResult._internal.callbacks.retrieveSuccess).toBeDefined();
    });

    it("should create a TxResult with serviceCalls", () => {
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
      const depTxResult = createServiceTxBuilder(testSchema, baseUow)
        .retrieve((uow) => uow.find("users", (b) => b.whereIndex("idx_email")))
        .transformRetrieve(([users]) => users[0] ?? null)
        .build();

      // Create a TxResult that depends on it
      const txResult = createServiceTxBuilder(testSchema, baseUow)
        .withServiceCalls(() => [depTxResult])
        .mutate(({ uow, serviceIntermediateResult: [user] }) => {
          if (!user) {
            throw new Error("User not found");
          }
          return uow.create("users", { email: "new@example.com", name: "New", balance: 0 });
        })
        .build();

      expect(isTxResult(txResult)).toBe(true);
      expect(txResult._internal.serviceCalls).toHaveLength(1);
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
      createServiceTxBuilder(testSchema, baseUow)
        .mutate(({ uow }) => {
          uow.create("users", { email: "test@example.com", name: "Test", balance: 0 });
          return { created: true as const, code: "ABC123" };
        })
        .transform(({ mutateResult }) => {
          // Key type assertion: mutateResult is NOT undefined when mutate callback IS provided
          expectTypeOf(mutateResult).toEqualTypeOf<{ created: true; code: string }>();
          // Should be able to access properties without null check
          return { success: true, code: mutateResult.code };
        })
        .build();
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
      createServiceTxBuilder(testSchema, baseUow)
        .retrieve((uow) => uow.find("users", (b) => b.whereIndex("idx_email")))
        .transformRetrieve(([users]) => users[0] ?? null)
        // NO mutate callback
        .transform(({ mutateResult, retrieveResult }) => {
          // Key type assertion: mutateResult IS undefined when no mutate callback
          expectTypeOf(mutateResult).toEqualTypeOf<undefined>();
          // retrieveResult should still be properly typed (can be null from ?? null)
          if (retrieveResult !== null) {
            expectTypeOf(retrieveResult.email).toEqualTypeOf<string>();
          }
          return { user: retrieveResult };
        })
        .build();
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
      createServiceTxBuilder(testSchema, baseUow)
        .retrieve((uow) => uow.find("users", (b) => b.whereIndex("idx_email")))
        // NO transformRetrieve callback - this is the key scenario
        .mutate(({ uow, retrieveResult }) => {
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
        })
        .build();
    });
  });

  describe("executeTx", () => {
    it("should execute a simple retrieve-only transaction", async () => {
      const compiler = createMockCompiler();
      const mockUsers = [
        {
          id: FragnoId.fromExternal("1", 1),
          email: "alice@example.com",
          name: "Alice",
          balance: 100,
        },
        {
          id: FragnoId.fromExternal("2", 1),
          email: "bob@example.com",
          name: "Bob",
          balance: 200,
        },
      ];
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [mockUsers],
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
      };
      const decoder = createMockDecoder();

      const [users] = await createHandlerTxBuilder({
        createUnitOfWork: () => createUnitOfWork(compiler, executor, decoder),
      })
        .retrieve(({ forSchema }) =>
          forSchema(testSchema).find("users", (b) => b.whereIndex("idx_email")),
        )
        .execute();

      expect(users).toHaveLength(2);
      expect(users[0].email).toBe("alice@example.com");
      expect(users[1].name).toBe("Bob");
    });

    it("should execute a simple mutate-only transaction", async () => {
      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [BigInt(1)] }),
      };
      const decoder = createMockDecoder();

      const result = await createHandlerTxBuilder({
        createUnitOfWork: () => createUnitOfWork(compiler, executor, decoder),
      })
        .mutate(({ forSchema }) => {
          const userId = forSchema(testSchema).create("users", {
            email: "test@example.com",
            name: "Test",
            balance: 100,
          });
          return { userId };
        })
        .execute();

      expect(result.userId).toBeInstanceOf(FragnoId);
    });

    it("should execute a transaction with serviceCalls as retrieve source", async () => {
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
        return createServiceTxBuilder(testSchema, currentUow!)
          .retrieve((uow) => uow.find("users", (b) => b.whereIndex("idx_email")))
          .transformRetrieve(([users]) => users[0] ?? null)
          .build();
      };

      const result = await createHandlerTxBuilder({
        createUnitOfWork: () => {
          currentUow = createUnitOfWork(compiler, executor, decoder);
          return currentUow;
        },
      })
        .withServiceCalls(() => [getUserById()])
        .transform(({ serviceResult: [user] }) => user)
        .execute();

      expect(result).toEqual(mockUser);
    });

    it("should execute a transaction with mutate callback using serviceCalls", async () => {
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
        return createServiceTxBuilder(testSchema, currentUow!)
          .retrieve((uow) => uow.find("users", (b) => b.whereIndex("idx_email")))
          .transformRetrieve(([users]) => users[0] ?? null)
          .build();
      };

      const result = await createHandlerTxBuilder({
        createUnitOfWork: () => {
          currentUow = createUnitOfWork(compiler, executor, decoder);
          return currentUow;
        },
      })
        .withServiceCalls(() => [getUserById()])
        .mutate(({ forSchema, serviceIntermediateResult: [user] }) => {
          if (!user) {
            return { ok: false as const };
          }
          const newUserId = forSchema(testSchema).create("users", {
            email: "new@example.com",
            name: "New User",
            balance: 0,
          });
          return { ok: true as const, newUserId };
        })
        .execute();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.newUserId).toBeInstanceOf(FragnoId);
      }
    });

    it("should execute a transaction with transform callback", async () => {
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
        return createServiceTxBuilder(testSchema, currentUow!)
          .retrieve((uow) => uow.find("users", (b) => b.whereIndex("idx_email")))
          .transformRetrieve(([users]) => users[0] ?? null)
          .build();
      };

      const result = await createHandlerTxBuilder({
        createUnitOfWork: () => {
          currentUow = createUnitOfWork(compiler, executor, decoder);
          return currentUow;
        },
      })
        .withServiceCalls(() => [getUserById()])
        .mutate(({ forSchema, serviceIntermediateResult: [user] }) => {
          if (!user) {
            return { created: false as const };
          }
          const newUserId = forSchema(testSchema).create("users", {
            email: "new@example.com",
            name: "New User",
            balance: 0,
          });
          return { created: true as const, newUserId };
        })
        .transform(({ serviceResult: [user], mutateResult }) => {
          return {
            originalUser: user,
            mutationResult: mutateResult,
            summary: "Transaction completed",
          };
        })
        .execute();

      expect(result.summary).toBe("Transaction completed");
      expect(result.originalUser).toEqual(mockUser);
      expect(result.mutationResult?.created).toBe(true);
    });

    it("should execute a transaction with serviceCalls (service composition)", async () => {
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
        return createServiceTxBuilder(testSchema, currentUow!)
          .retrieve((uow) =>
            uow.find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId))),
          )
          .transformRetrieve(([users]) => users[0] ?? null)
          .build();
      };

      const result = await createHandlerTxBuilder({
        createUnitOfWork: () => {
          currentUow = createUnitOfWork(compiler, executor, decoder);
          return currentUow;
        },
      })
        .withServiceCalls(() => [getUserById("1")])
        .mutate(({ forSchema, serviceIntermediateResult: [user] }) => {
          if (!user) {
            return { ok: false as const };
          }
          const orderId = forSchema(testSchema).create("users", {
            email: "order@example.com",
            name: "Order",
            balance: 0,
          });
          return { ok: true as const, orderId, forUser: user.email };
        })
        .execute();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.forUser).toBe("test@example.com");
        expect(result.orderId).toBeInstanceOf(FragnoId);
      }
    });

    it("should type check serviceCalls with undefined (optional service pattern)", async () => {
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

      // This test demonstrates that serviceCalls can contain TxResult | undefined
      // This is useful for optional service patterns like: optionalService?.method()
      const result = await createHandlerTxBuilder({
        createUnitOfWork: () => createUnitOfWork(compiler, executor, decoder),
      })
        .withServiceCalls(() => [optionalService?.getUser()])
        .mutate(({ forSchema, serviceIntermediateResult: [maybeUser] }) => {
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
        })
        .execute();

      // Since optionalService was undefined, maybeUser was undefined, so we hit the fallback path
      expect(result.hadUser).toBe(false);
      if (!result.hadUser) {
        expect(result.userId).toBeInstanceOf(FragnoId);
      }
    });

    it("should handle serviceCalls with mix of TxResult and undefined", async () => {
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
          createServiceTxBuilder(testSchema, currentUow!)
            .mutate(({ uow }): CreatedData => {
              const userId = uow.create("users", {
                email: "created@example.com",
                name: "Created User",
                balance: 0,
              });
              // Return arbitrary data from the mutation
              return { userId, generatedCode: "ABC123" };
            })
            .build(),
      };

      // Optional service that would also return mutation data
      const optionalService = undefined as
        | {
            generateExtra: () => TxResult<ExtraData, ExtraData>;
          }
        | undefined;

      const result = await createHandlerTxBuilder({
        createUnitOfWork: () => {
          currentUow = createUnitOfWork(compiler, executor, decoder);
          return currentUow;
        },
      })
        .withServiceCalls(
          () =>
            [definedService.createUserAndReturnCode(), optionalService?.generateExtra()] as const,
        )
        .mutate(({ forSchema, serviceIntermediateResult }) => {
          // serviceIntermediateResult contains the mutation results from service calls
          // (since service calls have no retrieveSuccess, the mutate result becomes the retrieve result for dependents)
          const [createdData, maybeExtra] = serviceIntermediateResult;

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
        })
        .transform(({ serviceResult, serviceIntermediateResult, mutateResult }) => {
          // Verify serviceResult types - these are the FINAL results from serviceCalls
          const [finalCreatedData, maybeFinalExtra] = serviceResult;

          // Type check: serviceResult should have same structure
          // The final result is CreatedData (since there's no transform callback on the dep)
          expectTypeOf(finalCreatedData).toEqualTypeOf<CreatedData>();
          expectTypeOf(maybeFinalExtra).toEqualTypeOf<ExtraData | undefined>();

          // serviceIntermediateResult should still be accessible in transform
          const [_retrieveData, maybeRetrieveExtra] = serviceIntermediateResult;
          expectTypeOf(maybeRetrieveExtra).toEqualTypeOf<ExtraData | undefined>();

          return {
            ...mutateResult,
            finalDepUserId: finalCreatedData.userId,
            finalDepCode: finalCreatedData.generatedCode,
            extraWasUndefined: maybeFinalExtra === undefined,
          };
        })
        .execute();

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

      const result = await createHandlerTxBuilder({
        createUnitOfWork: () => createUnitOfWork(compiler, executor, decoder),
        retryPolicy: new ExponentialBackoffRetryPolicy({ maxRetries: 5, initialDelayMs: 1 }),
      })
        .mutate(({ forSchema }) => {
          forSchema(testSchema).create("users", {
            email: "test@example.com",
            name: "Test",
            balance: 0,
          });
          return { createdAt: Date.now() };
        })
        .execute();

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
        createHandlerTxBuilder({
          createUnitOfWork: () => createUnitOfWork(compiler, executor, decoder),
          retryPolicy: new NoRetryPolicy(),
        })
          .mutate(() => ({ done: true }))
          .execute(),
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
        createHandlerTxBuilder({
          createUnitOfWork: () => createUnitOfWork(compiler, executor, decoder),
          signal: controller.signal,
        })
          .mutate(() => ({ done: true }))
          .execute(),
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

      await createHandlerTxBuilder({
        createUnitOfWork: () => {
          callCount++;
          return createUnitOfWork(compiler, executor, decoder);
        },
        retryPolicy: new LinearBackoffRetryPolicy({ maxRetries: 3, delayMs: 1 }),
      })
        .mutate(({ forSchema }) => {
          forSchema(testSchema).create("users", {
            email: "test@example.com",
            name: "Test",
            balance: 0,
          });
        })
        .execute();

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
        createHandlerTxBuilder({
          createUnitOfWork: () => createUnitOfWork(compiler, executor, decoder),
          retryPolicy: new LinearBackoffRetryPolicy({ maxRetries: 5, delayMs: 100 }),
          signal: controller.signal,
        })
          .mutate(() => ({ done: true }))
          .execute(),
      ).rejects.toThrow("Transaction execution aborted");
    });

    it("should pass serviceResult to transform callback with final results", async () => {
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
        return createServiceTxBuilder(testSchema, currentUow!)
          .retrieve((uow) =>
            uow.find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId))),
          )
          .transformRetrieve(([users]) => users[0] ?? null)
          .mutate(({ uow, retrieveResult: user }) => {
            expect(user).toEqual(mockUser);
            expectTypeOf(user).toEqualTypeOf<typeof mockUser>();
            if (!user) {
              return { updated: false as const };
            }
            uow.update("users", user.id, (b) => b.set({ balance: user.balance + 100 }).check());
            return { updated: true as const, newBalance: user.balance + 100 };
          })
          .build();
      };

      const result = await createHandlerTxBuilder({
        createUnitOfWork: () => {
          currentUow = createUnitOfWork(compiler, executor, decoder);
          return currentUow;
        },
      })
        .withServiceCalls(() => [getUserAndUpdateBalance("1")])
        .transform(
          ({ serviceResult: [depResult], serviceIntermediateResult: [depRetrieveResult] }) => {
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
        )
        .execute();

      expect(result.depUpdated).toBe(true);
      expect(result.depNewBalance).toBe(200);
    });
  });

  describe("return type priority", () => {
    it("should return transform result when transform callback is provided", async () => {
      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
      };
      const decoder = createMockDecoder();

      const result = await createHandlerTxBuilder({
        createUnitOfWork: () => createUnitOfWork(compiler, executor, decoder),
      })
        .retrieve(() => {
          // Empty retrieve - defaults to empty array
        })
        .transformRetrieve((ctx) => {
          expectTypeOf(ctx).toEqualTypeOf<unknown[]>();

          return "retrieveSuccess result" as const;
        })
        .mutate((ctx) => {
          expectTypeOf(ctx.retrieveResult).toEqualTypeOf<"retrieveSuccess result">();

          return "mutate result" as const;
        })
        .transform((ctx) => {
          expectTypeOf(ctx.retrieveResult).toEqualTypeOf<"retrieveSuccess result">();
          // mutateResult is NOT | undefined because mutate callback IS provided
          expectTypeOf(ctx.mutateResult).toEqualTypeOf<"mutate result">();
          // serviceResult and serviceIntermediateResult are empty tuples since no service calls callback
          expectTypeOf(ctx.serviceResult).toEqualTypeOf<readonly []>();
          expectTypeOf(ctx.serviceIntermediateResult).toEqualTypeOf<readonly []>();

          return "success result" as const;
        })
        .execute();

      expect(result).toBe("success result");
    });

    it("should return mutate result when no transform callback", async () => {
      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
      };
      const decoder = createMockDecoder();

      const result = await createHandlerTxBuilder({
        createUnitOfWork: () => createUnitOfWork(compiler, executor, decoder),
      })
        .transformRetrieve(() => "retrieveSuccess result")
        .mutate(() => "mutate result")
        .execute();

      expect(result).toBe("mutate result");
    });

    it("should return transformRetrieve result when no mutate or transform", async () => {
      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
      };
      const decoder = createMockDecoder();

      const result = await createHandlerTxBuilder({
        createUnitOfWork: () => createUnitOfWork(compiler, executor, decoder),
      })
        .transformRetrieve(() => "retrieveSuccess result")
        .execute();

      expect(result).toBe("retrieveSuccess result");
    });

    it("should return serviceCalls final results when no local callbacks", async () => {
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
        return createServiceTxBuilder(testSchema, currentUow!)
          .retrieve((uow) => uow.find("users", (b) => b.whereIndex("idx_email")))
          .transformRetrieve(([users]) => users[0] ?? null)
          .build();
      };

      // executeTx with only serviceCalls - should return serviceCalls' final results
      const result = await createHandlerTxBuilder({
        createUnitOfWork: () => {
          currentUow = createUnitOfWork(compiler, executor, decoder);
          return currentUow;
        },
      })
        .withServiceCalls(() => [getUser()])
        .execute();

      expect(result).toEqual([mockUser]);
    });
  });

  describe("serviceResult vs serviceIntermediateResult", () => {
    it("serviceIntermediateResult in mutate should contain transformRetrieve results", async () => {
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
      let capturedServiceIntermediateResult: unknown[] = [];

      const getUserById = () => {
        return (
          createServiceTxBuilder(testSchema, currentUow!)
            .retrieve((uow) => uow.find("users", (b) => b.whereIndex("idx_email")))
            // This transformRetrieve transforms the result
            .transformRetrieve(([users]) => ({ transformed: true, user: users[0] }))
            .build()
        );
      };

      await createHandlerTxBuilder({
        createUnitOfWork: () => {
          currentUow = createUnitOfWork(compiler, executor, decoder);
          return currentUow;
        },
      })
        .withServiceCalls(() => [getUserById()])
        .mutate(({ serviceIntermediateResult }) => {
          // Should receive the transformed (transformRetrieve) result
          capturedServiceIntermediateResult = [...serviceIntermediateResult];
          return { done: true };
        })
        .execute();

      expect(capturedServiceIntermediateResult[0]).toEqual({ transformed: true, user: mockUser });
    });

    it("serviceResult in transform should contain final (mutate) results", async () => {
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
      let capturedServiceResult: unknown[] = [];

      const getUserById = () => {
        return (
          createServiceTxBuilder(testSchema, currentUow!)
            .retrieve((uow) => uow.find("users", (b) => b.whereIndex("idx_email")))
            .transformRetrieve(([users]) => users[0])
            // This mutate returns a different result
            .mutate(({ retrieveResult: user }) => ({ mutated: true, userId: user?.id }))
            .build()
        );
      };

      await createHandlerTxBuilder({
        createUnitOfWork: () => {
          currentUow = createUnitOfWork(compiler, executor, decoder);
          return currentUow;
        },
      })
        .withServiceCalls(() => [getUserById()])
        .transform(({ serviceResult }) => {
          // Should receive the mutate result (final), not transformRetrieve result
          capturedServiceResult = [...serviceResult];
          return { done: true };
        })
        .execute();

      expect(capturedServiceResult[0]).toEqual({ mutated: true, userId: mockUser.id });
    });

    it("serviceResult in transform should contain mutateResult for mutate-only serviceCalls (via processTxResultAfterMutate)", async () => {
      // This test exercises the buggy code path in processTxResultAfterMutate:
      // When a nested TxResult has a transform callback and its serviceCall is mutate-only,
      // the transform callback should receive the mutateResult in
      // serviceResult, NOT the empty array.
      //
      // The key is that the nested service itself (wrapperService) has a transform callback,
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
      let capturedServiceIntermediateResultInNestedTransform: unknown[] = [];

      // Mutate-only service - no retrieve or transformRetrieve callbacks
      const createItem = () => {
        return (
          createServiceTxBuilder(testSchema, currentUow!)
            // NO retrieve or transformRetrieve - this is a mutate-only dep
            .mutate(({ uow }) => {
              const itemId = uow.create("users", {
                email: "new-item@example.com",
                name: "New Item",
                balance: 0,
              });
              return { created: true, itemId };
            })
            .build()
        );
      };

      // Wrapper service that has a transform callback and uses createItem as a dep
      // This forces processTxResultAfterMutate to be called for this TxResult
      const wrapperService = () => {
        return (
          createServiceTxBuilder(testSchema, currentUow!)
            .withServiceCalls(() => [createItem()] as const)
            // NO mutate callback - just pass through
            // The transform callback is the key: it makes processTxResultAfterMutate get called
            .transform(({ serviceResult, serviceIntermediateResult }) => {
              capturedServiceIntermediateResultInNestedTransform = [...serviceIntermediateResult];
              // serviceResult should equal serviceIntermediateResult since dep has no transform callback
              expect(serviceResult[0]).toEqual(serviceIntermediateResult[0]);
              return { wrapped: true, innerResult: serviceIntermediateResult[0] };
            })
            .build()
        );
      };

      const result = await createHandlerTxBuilder({
        createUnitOfWork: () => {
          currentUow = createUnitOfWork(compiler, executor, decoder);
          return currentUow;
        },
      })
        .withServiceCalls(() => [wrapperService()] as const)
        .transform(({ serviceResult: [wrapperResult] }) => wrapperResult)
        .execute();

      // The wrapper service's transform callback should have received the mutateResult, NOT empty array
      expect(capturedServiceIntermediateResultInNestedTransform[0]).toEqual({
        created: true,
        itemId: expect.any(FragnoId),
      });
      // Verify it's not the empty array sentinel
      expect(capturedServiceIntermediateResultInNestedTransform[0]).not.toEqual([]);

      // And the handler should get the wrapped result
      expect(result).toEqual({
        wrapped: true,
        innerResult: { created: true, itemId: expect.any(FragnoId) },
      });
    });
  });

  describe("nested TxResult serviceCalls (service composition)", () => {
    it("should collect nested serviceCalls in dependency order", async () => {
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

      // Simple service that retrieves - no nested serviceCalls
      const getUserById = (userId: string) => {
        getUserByIdCalled = true;
        if (!currentUow) {
          throw new Error("currentUow is null in getUserById!");
        }
        return createServiceTxBuilder(testSchema, currentUow)
          .retrieve((uow) =>
            uow.find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId))),
          )
          .transformRetrieve(([users]) => users[0] ?? null)
          .build();
      };

      // Service with serviceCalls - depends on getUserById
      const validateUser = (userId: string) => {
        validateUserCalled = true;
        if (!currentUow) {
          throw new Error("currentUow is null in validateUser!");
        }
        return (
          createServiceTxBuilder(testSchema, currentUow)
            .withServiceCalls(() => [getUserById(userId)] as const)
            // mutate callback receives serviceIntermediateResult
            .mutate(({ serviceIntermediateResult: [user] }) => {
              return { valid: user !== null, user };
            })
            .build()
        );
      };

      // Handler calls executeTx with serviceCalls containing validateUser
      // This tests 2-level nesting: handler -> validateUser -> getUserById
      const result = await createHandlerTxBuilder({
        createUnitOfWork: () => {
          currentUow = createUnitOfWork(compiler, executor, decoder);
          return currentUow;
        },
      })
        .withServiceCalls(() => [validateUser("user-1")] as const)
        .transform(({ serviceResult: [validationResult] }) => {
          return {
            isValid: validationResult.valid,
            userName: validationResult.user?.name,
          };
        })
        .execute();

      // Verify services were called
      expect(getUserByIdCalled).toBe(true);
      expect(validateUserCalled).toBe(true);
      expect(retrievePhaseExecuted).toBe(true);
      expect(result.isValid).toBe(true);
      expect(result.userName).toBe("Test User");
    }, 500);

    it("should handle a TxResult with serviceCalls that returns another TxResult", async () => {
      // This test reproduces the integration test scenario where:
      // - orderService.createOrderWithValidation has serviceCalls: () => [userService.getUserById(...)]
      // - handler has serviceCalls: () => [orderService.createOrderWithValidation(...)]

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
        return createServiceTxBuilder(testSchema, currentUow!)
          .retrieve((uow) =>
            uow.find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId))),
          )
          .transformRetrieve(([users]) => users[0] ?? null)
          .build();
      };

      // Simulates orderService.createOrderWithValidation - has serviceCalls on getUserById
      const createOrderWithValidation = (userId: string, productName: string) => {
        return createServiceTxBuilder(testSchema, currentUow!)
          .withServiceCalls(() => [getUserById(userId)] as const)
          .mutate(({ uow, serviceIntermediateResult: [user] }) => {
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
          })
          .build();
      };

      // Handler calls executeTx with serviceCalls containing the order service
      const result = await createHandlerTxBuilder({
        createUnitOfWork: () => {
          currentUow = createUnitOfWork(compiler, executor, decoder);
          return currentUow;
        },
      })
        .withServiceCalls(() => [createOrderWithValidation("user-1", "TypeScript Book")] as const)
        .transform(({ serviceResult: [orderResult] }) => {
          return {
            orderId: orderResult.orderId,
            forUser: orderResult.forUser,
            completed: true,
          };
        })
        .execute();

      expect(result.completed).toBe(true);
      expect(result.forUser).toBe("test@example.com");
      expect(result.orderId).toBeInstanceOf(FragnoId);
    }, 500); // Set 500ms timeout to catch deadlock

    it("should handle deeply nested TxResult serviceCalls (3 levels)", async () => {
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
        return createServiceTxBuilder(testSchema, currentUow!)
          .retrieve((uow) =>
            uow.find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId))),
          )
          .transformRetrieve(([users]) => users[0] ?? null)
          .build();
      };

      // Level 2: Depends on getUserById
      const validateUser = (userId: string) => {
        return createServiceTxBuilder(testSchema, currentUow!)
          .withServiceCalls(() => [getUserById(userId)] as const)
          .mutate(({ serviceIntermediateResult: [user] }) => {
            if (!user) {
              return { valid: false as const, reason: "User not found" };
            }
            return { valid: true as const, user };
          })
          .build();
      };

      // Level 1: Depends on validateUser
      const createOrder = (userId: string, productName: string) => {
        return createServiceTxBuilder(testSchema, currentUow!)
          .withServiceCalls(() => [validateUser(userId)] as const)
          .mutate(({ uow, serviceIntermediateResult: [validation] }) => {
            if (!validation.valid) {
              throw new Error(validation.reason);
            }
            const orderId = uow.create("users", {
              email: `order-${productName}@example.com`,
              name: productName,
              balance: 0,
            });
            return { orderId, forUser: validation.user.email };
          })
          .build();
      };

      // Handler: Depends on createOrder (3 levels deep)
      const result = await createHandlerTxBuilder({
        createUnitOfWork: () => {
          currentUow = createUnitOfWork(compiler, executor, decoder);
          return currentUow;
        },
      })
        .withServiceCalls(() => [createOrder("user-1", "Advanced TypeScript")] as const)
        .transform(({ serviceResult: [orderResult] }) => ({
          orderId: orderResult.orderId,
          forUser: orderResult.forUser,
          completed: true,
        }))
        .execute();

      expect(result.completed).toBe(true);
      expect(result.forUser).toBe("test@example.com");
      expect(result.orderId).toBeInstanceOf(FragnoId);
    }, 500); // Set 500ms timeout to catch deadlock
  });

  describe("triggerHook in serviceTx", () => {
    it("should record triggered hooks on the base UOW when using createServiceTx with retrieve and mutate", async () => {
      const compiler = createMockCompiler();
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

      const hooks: TestHooks = {
        onSubscribe: (payload: { email: string }) => {
          console.log(`onSubscribe: ${payload.email}`);
        },
      };

      // Service that retrieves a user and triggers a hook in mutate
      const subscribeUser = (email: string) => {
        return createServiceTxBuilder(testSchema, currentUow!, hooks)
          .retrieve((uow) =>
            uow.find("users", (b) => b.whereIndex("idx_email", (eb) => eb("email", "=", email))),
          )
          .transformRetrieve(([users]) => users[0] ?? null)
          .mutate(({ uow, retrieveResult: existingUser }) => {
            if (existingUser) {
              return { subscribed: false, email };
            }
            // Trigger hook when subscribing a new user
            uow.triggerHook("onSubscribe", { email });
            return { subscribed: true, email };
          })
          .build();
      };

      // Execute the transaction
      await createHandlerTxBuilder({
        createUnitOfWork: () => {
          currentUow = createUnitOfWork(compiler, executor, decoder);
          return currentUow;
        },
      })
        .withServiceCalls(() => [subscribeUser("new@example.com")] as const)
        .transform(({ serviceResult: [result] }) => result)
        .execute();

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

      const hooks: TestHooks = {
        onUserUpdated: (payload: { userId: string }) => {
          console.log(`onUserUpdated: ${payload.userId}`);
        },
      };

      // Service that uses raw retrieve results (no transformRetrieve) and triggers hook
      const updateUser = (userId: string) => {
        return (
          createServiceTxBuilder(testSchema, currentUow!, hooks)
            .retrieve((uow) =>
              uow.find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId))),
            )
            // NO transformRetrieve - mutate receives raw [users[]] array
            .mutate(({ uow, retrieveResult: [users] }) => {
              const user = users[0];
              if (!user) {
                return { updated: false };
              }
              uow.triggerHook("onUserUpdated", { userId: user.id.toString() });
              return { updated: true };
            })
            .build()
        );
      };

      await createHandlerTxBuilder({
        createUnitOfWork: () => {
          currentUow = createUnitOfWork(compiler, executor, decoder);
          return currentUow;
        },
      })
        .withServiceCalls(() => [updateUser("user-1")] as const)
        .transform(({ serviceResult: [result] }) => result)
        .execute();

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
    it("should not cause unhandled rejection when retrieve callback throws synchronously in serviceCalls", async () => {
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
        return createServiceTxBuilder(testSchema, currentUow!)
          .retrieve(() => {
            throw syncError;
          })
          .build();
      };

      // Execute with serviceCalls that contain the failing service
      // The error should be properly caught and re-thrown without unhandled rejection
      await expect(
        createHandlerTxBuilder({
          createUnitOfWork: () => {
            currentUow = createUnitOfWork(compiler, executor, decoder);
            return currentUow;
          },
        })
          .withServiceCalls(() => [failingService()] as const)
          .transform(({ serviceResult: [result] }) => result)
          .execute(),
      ).rejects.toThrow("Retrieve callback threw synchronously");
    });

    it("should not cause unhandled rejection when serviceCalls callback throws synchronously", async () => {
      // This test verifies that when a service's serviceCalls callback throws synchronously,
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

      // Service that throws synchronously in serviceCalls callback
      const failingService = () => {
        return createServiceTxBuilder(testSchema, currentUow!)
          .withServiceCalls(() => {
            throw syncError;
          })
          .mutate(() => ({ done: true }))
          .build();
      };

      // Execute with serviceCalls that contain the failing service
      await expect(
        createHandlerTxBuilder({
          createUnitOfWork: () => {
            currentUow = createUnitOfWork(compiler, executor, decoder);
            return currentUow;
          },
        })
          .withServiceCalls(() => [failingService()] as const)
          .transform(({ serviceResult: [result] }) => result)
          .execute(),
      ).rejects.toThrow("Deps callback threw synchronously");
    });
  });

  describe("mutate-only service type inference", () => {
    it("should correctly type serviceIntermediateResult when dependent service only has mutate (no retrieve)", async () => {
      // This test verifies that when a service has ONLY a mutate callback (no retrieve),
      // the mutate result is correctly typed as the serviceIntermediateResult for dependent services.
      //
      // Execution order:
      // 1. generateOTP's retrieve phase runs (empty - no retrieve callback)
      // 2. generateOTP's mutate runs → returns { otpId, code }
      // 3. sendOTPEmail's mutate runs → serviceIntermediateResult[0] is { otpId, code, userId }
      //
      // Without the InferBuilderRetrieveSuccessResult fix, serviceIntermediateResult[0] would be
      // typed as `[]` (empty tuple) even though at runtime it's the mutate result.

      const compiler = createMockCompiler();
      const executor: UOWExecutor<unknown, unknown> = {
        executeRetrievalPhase: async () => {
          return [];
        },
        executeMutationPhase: async () => {
          return {
            success: true,
            createdInternalIds: [],
          };
        },
      };
      const decoder = createMockDecoder();

      let currentUow: IUnitOfWork | null = null;

      // Capture the runtime value of serviceResult to verify it contains the mutate result
      let capturedOtpResult: unknown = null;

      // Mutate-only service - simulates OTP generation
      // No .retrieve() - this service doesn't need to read anything first
      const generateOTP = (userId: string) => {
        return createServiceTxBuilder(testSchema, currentUow!)
          .mutate(({ uow }) => {
            const otpId = uow.create("users", {
              email: `otp-${userId}@example.com`,
              name: "OTP Record",
              balance: 0,
            });
            // Return data that dependents need - this becomes serviceResult for them
            return { otpId, code: "ABC123", userId };
          })
          .build();
      };

      // Service that depends on generateOTP
      // The key test: serviceIntermediateResult[0] should be typed as { otpId, code, userId }
      const sendOTPEmail = (userId: string, email: string) => {
        return createServiceTxBuilder(testSchema, currentUow!)
          .withServiceCalls(() => [generateOTP(userId)] as const)
          .mutate(({ uow, serviceIntermediateResult: [otpResult] }) => {
            // RUNTIME CAPTURE: Store the actual runtime value for verification
            capturedOtpResult = otpResult;

            // TYPE TEST: Without the fix, this would require a manual cast.
            // With the fix, TypeScript knows otpResult is { otpId: FragnoId, code: string, userId: string }
            expectTypeOf(otpResult).toEqualTypeOf<{
              otpId: FragnoId;
              code: string;
              userId: string;
            }>();

            // Access properties without type errors - proves the type inference works
            const message = `Your OTP code is: ${otpResult.code}`;

            uow.create("users", {
              email,
              name: message,
              balance: 0,
            });

            return { sent: true, forUser: otpResult.userId };
          })
          .build();
      };

      const result = await createHandlerTxBuilder({
        createUnitOfWork: () => {
          currentUow = createUnitOfWork(compiler, executor, decoder);
          return currentUow;
        },
      })
        .withServiceCalls(() => [sendOTPEmail("user-1", "test@example.com")] as const)
        .transform(({ serviceResult: [emailResult] }) => emailResult)
        .execute();

      expect(result.sent).toBe(true);
      expect(result.forUser).toBe("user-1");

      // RUNTIME VERIFICATION: Verify the actual runtime value of serviceIntermediateResult
      // This proves generateOTP's mutate result is actually passed as serviceIntermediateResult
      expect(capturedOtpResult).not.toBeNull();
      expect(capturedOtpResult).toMatchObject({
        code: "ABC123",
        userId: "user-1",
      });
      expect((capturedOtpResult as { otpId: FragnoId }).otpId).toBeInstanceOf(FragnoId);
    });

    it("should correctly type serviceIntermediateResult with multiple mutate-only service calls", async () => {
      // Test with multiple mutate-only dependencies to verify tuple typing works

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

      // Capture runtime values for verification
      let capturedAuditResult: unknown = null;
      let capturedCounterResult: unknown = null;

      // First mutate-only service
      const createAuditLog = (action: string) => {
        return createServiceTxBuilder(testSchema, currentUow!)
          .mutate(({ uow }) => {
            const logId = uow.create("users", {
              email: `audit-${action}@example.com`,
              name: action,
              balance: 0,
            });
            return { logId, action, timestamp: 1234567890 };
          })
          .build();
      };

      // Second mutate-only service
      const incrementCounter = (name: string) => {
        return createServiceTxBuilder(testSchema, currentUow!)
          .mutate(() => {
            // Simulates incrementing a counter - returns the new value
            return { counterName: name, newValue: 42 };
          })
          .build();
      };

      const result = await createHandlerTxBuilder({
        createUnitOfWork: () => {
          currentUow = createUnitOfWork(compiler, executor, decoder);
          return currentUow;
        },
      })
        .withServiceCalls(
          () => [createAuditLog("user_login"), incrementCounter("login_count")] as const,
        )
        .mutate(({ serviceIntermediateResult: [auditResult, counterResult] }) => {
          // RUNTIME CAPTURE: Store the actual runtime values
          capturedAuditResult = auditResult;
          capturedCounterResult = counterResult;

          // TYPE TESTS: Both should be correctly typed from their mutate results
          expectTypeOf(auditResult).toEqualTypeOf<{
            logId: FragnoId;
            action: string;
            timestamp: number;
          }>();
          expectTypeOf(counterResult).toEqualTypeOf<{
            counterName: string;
            newValue: number;
          }>();

          // Access properties - proves type inference works
          return {
            auditAction: auditResult.action,
            loginCount: counterResult.newValue,
          };
        })
        .execute();

      expect(result.auditAction).toBe("user_login");
      expect(result.loginCount).toBe(42);

      // RUNTIME VERIFICATION: Verify the actual runtime values
      expect(capturedAuditResult).toMatchObject({
        action: "user_login",
        timestamp: 1234567890,
      });
      expect((capturedAuditResult as { logId: FragnoId }).logId).toBeInstanceOf(FragnoId);

      expect(capturedCounterResult).toEqual({
        counterName: "login_count",
        newValue: 42,
      });
    });
  });
});
