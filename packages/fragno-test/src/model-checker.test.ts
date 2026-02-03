import { describe, expect, it, vi } from "vitest";
import { InMemoryAdapter } from "@fragno-dev/db";
import { column, idColumn, schema, type FragnoId } from "@fragno-dev/db/schema";
import type { UnitOfWorkConfig } from "@fragno-dev/db/unit-of-work";
import {
  createRawUowTransaction,
  defaultStateHasher,
  defaultTraceHasher,
  runModelChecker,
  type ModelCheckerTraceEvent,
  type ModelCheckerStateHasherContext,
} from "./model-checker";

const testSchema = schema("test", (s) =>
  s.addTable("users", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("name", column("string"))
      .createIndex("idx_users_name", ["name"]),
  ),
);

const createContext = async () => {
  const adapter = new InMemoryAdapter({ idSeed: "model-checker" });
  const queryEngine = adapter.createQueryEngine(testSchema, "model-checker");
  return {
    ctx: {
      queryEngine,
      createUnitOfWork: queryEngine.createUnitOfWork,
    },
    cleanup: async () => {
      await adapter.close();
    },
  };
};

describe("model checker", () => {
  it("generates all interleavings for two two-step transactions", async () => {
    const result = await runModelChecker({
      schema: testSchema,
      mode: "exhaustive",
      history: false,
      createContext,
      setup: async (ctx) => {
        await ctx.queryEngine.create("users", { name: "seed" });
      },
      buildTransactions: (ctx) => {
        const buildTx = (label: string) => {
          let uow = ctx.createUnitOfWork(`${label}-retrieve`);
          let userCount = 0;
          return {
            retrieve: async () => {
              uow.find("users", (b) => b.whereIndex("primary"));
              const results = (await uow.executeRetrieve()) as unknown[];
              const rows = (results[0] ?? []) as Array<{ name: string }>;
              userCount = rows.length;
              return userCount;
            },
            mutate: async () => {
              uow.create("users", { name: `${label}-${userCount}` });
              const { success } = await uow.executeMutations();
              if (!success) {
                throw new Error("Mutation failed");
              }
            },
          };
        };

        return [buildTx("alpha"), buildTx("beta")];
      },
    });

    expect(result.schedules).toHaveLength(6);
    for (const schedule of result.schedules) {
      expect(schedule.schedule).toHaveLength(4);
    }
  });

  it("hashes state changes deterministically", async () => {
    const { ctx, cleanup } = await createContext();
    try {
      const emptyHash = await defaultStateHasher({
        schema: testSchema,
        queryEngine: ctx.queryEngine,
      });
      await ctx.queryEngine.create("users", { name: "after" });
      const nextHash = await defaultStateHasher({
        schema: testSchema,
        queryEngine: ctx.queryEngine,
      });
      expect(emptyHash).not.toEqual(nextHash);
    } finally {
      await cleanup();
    }
  });

  it("generates deterministic random schedules with a seed", async () => {
    const buildTransactions = () => [
      {
        retrieve: async () => "alpha",
        mutate: async () => undefined,
      },
      {
        retrieve: async () => "beta",
        mutate: async () => undefined,
      },
    ];

    const run = async () =>
      runModelChecker({
        schema: testSchema,
        mode: "random",
        seed: 123,
        maxSchedules: 3,
        history: false,
        createContext,
        buildTransactions,
      });

    const [first, second] = await Promise.all([run(), run()]);

    expect(first.schedules).toEqual(second.schedules);
  });

  it("stops infinite mode when the frontier is exhausted", async () => {
    const result = await runModelChecker({
      schema: testSchema,
      mode: "infinite",
      seed: 7,
      maxSchedules: 10,
      stopWhenFrontierExhausted: true,
      createContext,
      buildTransactions: () => [
        {
          retrieve: async () => "only-step",
        },
      ],
    });

    expect(result.schedules).toHaveLength(2);
    expect(result.visitedPaths).toBe(1);
  });

  it("builds raw UOW transactions with a shared unit of work", async () => {
    let createUnitOfWorkCalls = 0;

    const result = await runModelChecker({
      schema: testSchema,
      history: false,
      createContext: async () => {
        const adapter = new InMemoryAdapter({ idSeed: "model-checker" });
        const queryEngine = adapter.createQueryEngine(testSchema, "model-checker");
        const createUnitOfWork = vi.fn(queryEngine.createUnitOfWork.bind(queryEngine));
        createUnitOfWork.mockImplementation((name, config) => {
          createUnitOfWorkCalls += 1;
          return queryEngine.createUnitOfWork(name, config);
        });
        return {
          ctx: {
            queryEngine,
            createUnitOfWork,
          },
          cleanup: async () => {
            await adapter.close();
          },
        };
      },
      buildTransactions: (_ctx) => [
        createRawUowTransaction<unknown, unknown, typeof testSchema, UnitOfWorkConfig>({
          name: "alpha",
          retrieve: async (uow) => {
            uow.find("users", (b) => b.whereIndex("primary"));
            const results = (await uow.executeRetrieve()) as unknown[];
            const rows = (results[0] ?? []) as Array<{ name: string }>;
            return rows.length;
          },
          mutate: async (uow, txCtx) => {
            uow.create("users", { name: `alpha-${txCtx.retrieveResult}` });
            const { success } = await uow.executeMutations();
            if (!success) {
              throw new Error("Mutation failed");
            }
          },
        }),
      ],
    });

    expect(result.schedules).toHaveLength(1);
    expect(createUnitOfWorkCalls).toBe(1);
  });

  it("surfaces invariant violations across interleavings", async () => {
    const reservationSchema = schema("reservation", (s) =>
      s
        .addTable("stock", (t) => t.addColumn("id", idColumn()).addColumn("remaining", "integer"))
        .addTable("orders", (t) => t.addColumn("id", idColumn()).addColumn("note", "string")),
    );

    const createContext = async () => {
      const adapter = new InMemoryAdapter({ idSeed: "model-checker-invariant" });
      const queryEngine = adapter.createQueryEngine(reservationSchema, "model-checker-invariant");
      return {
        ctx: {
          queryEngine,
          createUnitOfWork: queryEngine.createUnitOfWork,
        },
        cleanup: async () => {
          await adapter.close();
        },
      };
    };

    const maxOrders = 1;
    const stateHasher = async (
      ctx: ModelCheckerStateHasherContext<typeof reservationSchema, UnitOfWorkConfig>,
    ) => {
      const orders = await ctx.queryEngine.find("orders", (b) => b.whereIndex("primary"));
      if (orders.length > maxOrders) {
        throw new Error(
          `Invariant violated: expected at most ${maxOrders} orders, found ${orders.length}`,
        );
      }
      return defaultStateHasher(ctx);
    };

    const buildBuyer = (label: string) =>
      createRawUowTransaction<
        { stockId: string | FragnoId; remaining: number },
        void,
        typeof reservationSchema,
        UnitOfWorkConfig
      >({
        name: label,
        retrieve: async (uow) => {
          uow.find("stock", (b) => b.whereIndex("primary"));
          const results = (await uow.executeRetrieve()) as unknown[];
          const rows = (results[0] ?? []) as Array<{ id: string | FragnoId; remaining: number }>;
          const stock = rows[0];
          if (!stock) {
            throw new Error("Stock row missing");
          }
          return { stockId: stock.id, remaining: stock.remaining };
        },
        mutate: async (uow, txCtx) => {
          if (txCtx.retrieveResult.remaining <= 0) {
            return;
          }
          uow.create("orders", { note: `order-${label}` });
          uow.update("stock", txCtx.retrieveResult.stockId, (b) =>
            b.set({ remaining: txCtx.retrieveResult.remaining - 1 }),
          );
          const { success } = await uow.executeMutations();
          if (!success) {
            throw new Error("Mutation failed");
          }
        },
      });

    await expect(
      runModelChecker({
        schema: reservationSchema,
        mode: "exhaustive",
        history: false,
        stateHasher,
        createContext,
        setup: async (ctx) => {
          await ctx.queryEngine.create("stock", { remaining: maxOrders });
        },
        buildTransactions: () => [buildBuyer("buyer-a"), buildBuyer("buyer-b")],
      }),
    ).rejects.toThrow("Invariant violated");
  });

  it("records trace events for UOW outputs and mutations", async () => {
    const events: ModelCheckerTraceEvent[] = [];
    const runtime = {
      time: {
        now: () => new Date("2025-01-01T00:00:00.000Z"),
      },
      random: {
        float: () => 0.25,
        uuid: () => "00000000-0000-4000-8000-000000000000",
        cuid: () => "cuid_0000000000000000",
      },
    };

    await runModelChecker({
      schema: testSchema,
      history: false,
      runtime,
      traceRecorder: (event) => events.push(event),
      createContext,
      setup: async (ctx) => {
        await ctx.queryEngine.create("users", { name: "seed" });
      },
      buildTransactions: () => [
        createRawUowTransaction<unknown, unknown, typeof testSchema, UnitOfWorkConfig>({
          name: "trace-tx",
          retrieve: async (uow, ctx) => {
            ctx.runtime?.random.float();
            uow.find("users", (b) => b.whereIndex("primary"));
            await uow.executeRetrieve();
            return "done";
          },
          mutate: async (uow, ctx) => {
            ctx.runtime?.random.uuid();
            ctx.runtime?.random.cuid();
            ctx.runtime?.time.now();
            uow.create("users", { name: "trace" });
            await uow.executeMutations();
          },
        }),
      ],
    });

    const eventTypes = new Set(events.map((event) => event.type));
    expect(eventTypes).toContain("schedule-step");
    expect(eventTypes).toContain("retrieve-output");
    expect(eventTypes).toContain("mutation-input");
    expect(eventTypes).toContain("mutation-result");
    expect(eventTypes).toContain("runtime");
  });

  it("records runtime trace events during model checker runs", async () => {
    const events: ModelCheckerTraceEvent[] = [];
    const runtime = {
      time: {
        now: () => new Date("2025-01-01T00:00:00.000Z"),
      },
      random: {
        float: () => 0.5,
        uuid: () => "11111111-1111-4111-8111-111111111111",
        cuid: () => "cuid_1111111111111111",
      },
    };

    await runModelChecker({
      schema: testSchema,
      history: false,
      runtime,
      traceRecorder: (event) => events.push(event),
      createContext,
      buildTransactions: () => [
        createRawUowTransaction<unknown, unknown, typeof testSchema, UnitOfWorkConfig>({
          name: "runtime-tx",
          retrieve: async (_uow, ctx) => {
            ctx.runtime?.random.float();
            ctx.runtime?.random.uuid();
            ctx.runtime?.time.now();
            return "ok";
          },
        }),
      ],
    });

    const runtimeEvents = events.filter((event) => event.type === "runtime");
    expect(runtimeEvents.length).toBeGreaterThan(0);
  });

  it("produces deterministic trace hashes", async () => {
    const runtime = {
      time: {
        now: () => new Date("2025-01-01T00:00:00.000Z"),
      },
      random: {
        float: () => 0.75,
        uuid: () => "22222222-2222-4222-8222-222222222222",
        cuid: () => "cuid_2222222222222222",
      },
    };

    const run = () =>
      runModelChecker({
        schema: testSchema,
        history: false,
        runtime,
        traceHasher: defaultTraceHasher,
        createContext,
        buildTransactions: () => [
          createRawUowTransaction<unknown, unknown, typeof testSchema, UnitOfWorkConfig>({
            name: "hash-tx",
            retrieve: async (uow, ctx) => {
              ctx.runtime?.random.float();
              uow.find("users", (b) => b.whereIndex("primary"));
              await uow.executeRetrieve();
              return "ok";
            },
            mutate: async (uow) => {
              uow.create("users", { id: "hash-id", name: "hash" });
              await uow.executeMutations();
            },
          }),
        ],
      });

    const [first, second] = await Promise.all([run(), run()]);
    expect(first.schedules[0]?.traceHash).toEqual(second.schedules[0]?.traceHash);
  });
});
