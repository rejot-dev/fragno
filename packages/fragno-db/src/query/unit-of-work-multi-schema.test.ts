import { describe, test } from "vitest";
import { schema, column, idColumn, referenceColumn } from "../schema/create";
import type { UOWCompiler, UOWExecutor, UOWDecoder } from "./unit-of-work";
import { createUnitOfWork } from "./unit-of-work";

// Test schemas
const schema1 = schema((s) =>
  s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
);

const schema2 = schema((s) =>
  s.addTable("posts", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("userId", referenceColumn())
      .addColumn("title", column("string")),
  ),
);

// Mock compiler, executor, and decoder
const mockCompiler: UOWCompiler<string> = {
  compileRetrievalOperation: (op) => `RETRIEVE-${op.type}-${op.table.name}-${op.indexName}`,
  compileMutationOperation: (op) => ({
    query: `MUTATE-${op.type}`,
    expectedAffectedRows: null,
  }),
};

const mockExecutor: UOWExecutor<string, string> = {
  executeRetrievalPhase: async (queries) => queries.map((q) => `RESULT-${q}`),
  executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
};

const mockDecoder: UOWDecoder<string> = (rawResults) => rawResults.map((r) => ({ decoded: r }));

describe("Multi-Schema Unit of Work", () => {
  test("chained operations on view accumulate result types", async () => {
    const uow = createUnitOfWork(schema1, mockCompiler, mockExecutor, mockDecoder);

    // Chain multiple finds on same view
    const _view1 = uow
      .forSchema(schema1)
      .find("users", (b) => b.whereIndex("primary").select(["id"]))
      .find("users", (b) => b.whereIndex("primary").select(["name"]));

    const _view2 = uow
      .forSchema(schema2)
      .find("posts", (b) => b.whereIndex("primary").select(["title"]));

    await uow.executeRetrieve();

    // const [[users1, users2], [posts]] = await Promise.all([view1.retrievalPhase, view2.retrievalPhase]);

    // const [users1, users2] = await view1.retrievalPhase;

    // // expect(users1)

    // // expectTypeOf(users1).toMatchObjectType<{ id: FragnoId; name: string }[]>();
    // console.log({ users1, users2 });

    // const [posts] = await view2.retrievalPhase;
    // console.log({ posts });
  });
});
