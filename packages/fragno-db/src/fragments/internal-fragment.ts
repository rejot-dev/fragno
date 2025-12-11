import { FragmentDefinitionBuilder } from "@fragno-dev/core";
import type { InstantiatedFragmentFromDefinition } from "@fragno-dev/core";
import {
  DatabaseFragmentDefinitionBuilder,
  type DatabaseHandlerContext,
  type DatabaseRequestStorage,
  type DatabaseServiceContext,
  type FragnoPublicConfigWithDatabase,
  type ImplicitDatabaseDependencies,
} from "../db-fragment-definition-builder";
import type { FragnoId } from "../schema/create";
import { schema, idColumn, column } from "../schema/create";

// Constants for Fragno's internal settings table
export const SETTINGS_TABLE_NAME = "fragno_db_settings" as const;
// FIXME: In some places we simply use empty string "" as namespace, which is not correct.
export const SETTINGS_NAMESPACE = "fragno-db-settings" as const;

// Settings schema for storing Fragno's internal key-value settings
export const settingsSchema = schema((s) => {
  return s.addTable(SETTINGS_TABLE_NAME, (t) => {
    return t
      .addColumn("id", idColumn())
      .addColumn("key", column("string"))
      .addColumn("value", column("string"))
      .createIndex("unique_key", ["key"], { unique: true });
  });
});

// This uses DatabaseFragmentDefinitionBuilder directly
// to avoid circular dependency (it doesn't need to link to itself)
export const internalFragmentDef = new DatabaseFragmentDefinitionBuilder(
  new FragmentDefinitionBuilder<
    {},
    FragnoPublicConfigWithDatabase,
    ImplicitDatabaseDependencies<typeof settingsSchema>,
    {},
    {},
    {},
    {},
    DatabaseServiceContext,
    DatabaseHandlerContext,
    DatabaseRequestStorage
  >("$fragno-internal-fragment"),
  settingsSchema,
  "", // intentionally blank namespace so there is no prefix
)
  .providesService("settingsService", ({ defineService }) => {
    return defineService({
      async get(
        namespace: string,
        key: string,
      ): Promise<{ id: FragnoId; key: string; value: string } | undefined> {
        const fullKey = `${namespace}.${key}`;
        const uow = this.uow(settingsSchema).find(SETTINGS_TABLE_NAME, (b) =>
          b.whereIndex("unique_key", (eb) => eb("key", "=", fullKey)),
        );
        const [results] = await uow.retrievalPhase;
        return results?.[0];
      },

      async set(namespace: string, key: string, value: string) {
        const fullKey = `${namespace}.${key}`;
        const uow = this.uow(settingsSchema);

        // First, find if the key already exists
        const findUow = uow.find(SETTINGS_TABLE_NAME, (b) =>
          b.whereIndex("unique_key", (eb) => eb("key", "=", fullKey)),
        );
        const [existing] = await findUow.retrievalPhase;

        if (existing?.[0]) {
          uow.update(SETTINGS_TABLE_NAME, existing[0].id, (b) => b.set({ value }).check());
        } else {
          uow.create(SETTINGS_TABLE_NAME, {
            key: fullKey,
            value,
          });
        }

        // Await mutation phase - will throw if mutation fails
        await uow.mutationPhase;
      },

      async delete(id: FragnoId) {
        const uow = this.uow(settingsSchema);
        uow.delete(SETTINGS_TABLE_NAME, id);
        await uow.mutationPhase;
      },
    });
  })
  .build();

/**
 * Type representing an instantiated internal fragment.
 * This is the fragment that manages Fragno's internal settings table.
 */
export type InternalFragmentInstance = InstantiatedFragmentFromDefinition<
  typeof internalFragmentDef
>;

export async function getSchemaVersionFromDatabase(
  fragment: InternalFragmentInstance,
  namespace: string,
): Promise<number> {
  try {
    const version = await fragment.inContext(async function () {
      const version = await this.uow(async ({ executeRetrieve }) => {
        const version = fragment.services.settingsService.get(namespace, "schema_version");
        await executeRetrieve();
        return version;
      });

      return version ? parseInt(version.value, 10) : 0;
    });
    return version;
  } catch {
    return 0;
  }
}
