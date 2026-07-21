import { describe, expect, it, assert } from "vitest";

import { column, idColumn, schema } from "@fragno-dev/db/schema";

import type { DatabaseRequestContext } from "@fragno-dev/db";

import type { FragnoCollectionUtils } from "./collection-options";
import {
  createIngestScenarioSteps,
  defineIngestScenario,
  runIngestScenario,
  type IngestScenarioCollectionOptionsFactory,
} from "./scenario";

const appSchema = schema("app", (s) =>
  s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
);

const steps = createIngestScenarioSteps<typeof appSchema, "users">();

const createNoopCollectionOptions = (({ id }) => ({
  id,
  getKey: (row) => row.id,
  sync: {
    sync({ markReady }) {
      markReady();
    },
  },
  utils: {
    getSyncStatus: () => "ready",
    getLastError: () => undefined,
    initialSync: () => Promise.resolve(),
    async syncOnce() {},
    getCheckpoint() {
      return undefined;
    },
  } satisfies FragnoCollectionUtils,
})) satisfies IngestScenarioCollectionOptionsFactory<typeof appSchema, "users">;

describe("ingest scenario setup", () => {
  it("provides separate SQLite databases for the Fragno backend and frontend persistence", async () => {
    const scenario = defineIngestScenario({
      name: "sqlite-boundaries",
      schema: appSchema,
      table: "users",
      collectionOptions: createNoopCollectionOptions,
      steps: [
        steps.server(async ({ server }) => {
          await server.fragment.fragment.inContext(async function (this: DatabaseRequestContext) {
            await this.handlerTx()
              .mutate(({ forSchema }) =>
                forSchema(appSchema).create("users", { id: "user-1", name: "Ada" }),
              )
              .execute();
          });
        }),
        steps.ingest(),
        steps.assert(async ({ server, frontend }) => {
          const outboxResponse = await server.fetch(`${server.internalUrl}/outbox`);
          assert(outboxResponse.status === 200);
          await expect(outboxResponse.json()).resolves.toHaveLength(1);

          const frontendTables = frontend.database
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .all() as Array<{ name: string }>;
          expect(frontendTables.map(({ name }) => name)).toEqual(
            expect.arrayContaining(["collection_registry", "collection_metadata"]),
          );
        }),
      ],
    });

    const context = await runIngestScenario(scenario);
    await context.cleanup();
  });
});
