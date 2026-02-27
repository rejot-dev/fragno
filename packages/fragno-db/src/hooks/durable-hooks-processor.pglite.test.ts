import { describe, expect, it, vi } from "vitest";
import { defineFragment, instantiate } from "@fragno-dev/core";
import { KyselyPGlite } from "kysely-pglite";
import { PGlite } from "@electric-sql/pglite";
import { withDatabase } from "../with-database";
import { column, idColumn, schema } from "../schema/create";
import { SqlAdapter } from "../adapters/generic-sql/generic-sql-adapter";
import { PGLiteDriverConfig } from "../adapters/generic-sql/driver-config";
import { internalSchema } from "../fragments/internal-fragment.schema";
import { createDurableHooksProcessor } from "./durable-hooks-processor";

const testSchema = schema("hook_test", (s) =>
  s.addTable("items", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
);

async function createPgliteAdapter() {
  const pglite = new PGlite();
  const { dialect } = new KyselyPGlite(pglite);
  const adapter = new SqlAdapter({
    dialect,
    driverConfig: new PGLiteDriverConfig(),
  });

  const internalMigrations = adapter.prepareMigrations(internalSchema, null);
  await internalMigrations.executeWithDriver(adapter.driver, 0);

  const testMigrations = adapter.prepareMigrations(testSchema, testSchema.name);
  await testMigrations.executeWithDriver(adapter.driver, 0);

  return {
    adapter,
    cleanup: async () => {
      await adapter.close();
    },
  };
}

describe("durable hooks with pglite", () => {
  it("keeps durable hooks processing after duplicate hook ids", async () => {
    const hookFn = vi.fn();
    const fragmentDefinition = defineFragment("hook-test")
      .extend(withDatabase(testSchema))
      .provideHooks(({ defineHook }) => ({
        onTest: defineHook(async function (payload: { ok: boolean }) {
          hookFn(payload.ok);
        }),
      }))
      .build();

    const { adapter, cleanup } = await createPgliteAdapter();

    try {
      const fragment = instantiate(fragmentDefinition)
        .withConfig({})
        .withRoutes([])
        .withOptions({ databaseAdapter: adapter, durableHooks: { autoSchedule: false } })
        .build();

      const processor = createDurableHooksProcessor(fragment);
      const hookId = "hook-id-duplicate";

      const triggerHook = async () => {
        await fragment.inContext(async function () {
          await this.handlerTx()
            .mutate(({ forSchema }) => {
              const uow = forSchema(testSchema);
              uow.triggerHook("onTest", { ok: true }, { id: hookId });
            })
            .execute();
        });
      };

      await triggerHook();
      await expect(triggerHook()).rejects.toThrow();

      await processor.drain();

      expect(hookFn).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup();
    }
  });
});
