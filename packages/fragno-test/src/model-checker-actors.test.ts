import { describe, expect, it } from "vitest";
import { InMemoryAdapter } from "@fragno-dev/db";
import { column, idColumn, schema } from "@fragno-dev/db/schema";
import { ModelCheckerAdapter } from "./model-checker-adapter";
import { runModelCheckerWithActors } from "./model-checker-actors";

const testSchema = schema("test", (s) =>
  s.addTable("items", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
);

const createContext = async () => {
  const adapter = new InMemoryAdapter({ idSeed: "model-checker-actors" });
  const modelAdapter = new ModelCheckerAdapter(adapter);
  const queryEngine = modelAdapter.createQueryEngine(testSchema, "model-checker-actors");

  return {
    adapter: modelAdapter,
    ctx: { queryEngine },
    queryEngine,
    cleanup: async () => {
      await adapter.close();
    },
  };
};

describe("model checker actors", () => {
  it("exhaustively explores bounded interleavings", async () => {
    const result = await runModelCheckerWithActors({
      schema: testSchema,
      mode: "bounded-exhaustive",
      bounds: { maxSteps: 2 },
      history: false,
      createContext,
      setup: async ({ queryEngine }) => {
        await queryEngine.create("items", { name: "seed" });
      },
      buildActors: ({ queryEngine }) => [
        {
          name: "tx-a",
          run: async () => {
            const uow = queryEngine.createUnitOfWork("tx-a");
            uow.find("items", (b) => b.whereIndex("primary"));
            await uow.executeRetrieve();
            uow.create("items", { name: "alpha" });
            const { success } = await uow.executeMutations();
            if (!success) {
              throw new Error("tx-a mutation failed");
            }
          },
        },
        {
          name: "tx-b",
          run: async () => {
            const uow = queryEngine.createUnitOfWork("tx-b");
            uow.find("items", (b) => b.whereIndex("primary"));
            await uow.executeRetrieve();
            uow.create("items", { name: "beta" });
            const { success } = await uow.executeMutations();
            if (!success) {
              throw new Error("tx-b mutation failed");
            }
          },
        },
      ],
    });

    const prefixes = new Set(
      result.schedules.map((entry) =>
        entry.schedule
          .slice(0, 2)
          .map((step) => `${step.txId}:${step.phase}`)
          .join("|"),
      ),
    );

    expect(prefixes.size).toBe(2);
  });
});
