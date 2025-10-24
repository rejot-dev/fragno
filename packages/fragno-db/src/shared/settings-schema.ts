import type { AbstractQuery } from "../query/query";
import { schema, idColumn, column, type FragnoId } from "../schema/create";

export const SETTINGS_TABLE_NAME = "fragno_db_settings" as const;
export const SETTINGS_NAMESPACE = "fragno-db-settings" as const;

export const settingsSchema = schema((s) => {
  return s.addTable(SETTINGS_TABLE_NAME, (t) => {
    return t
      .addColumn("id", idColumn())
      .addColumn("key", column("string"))
      .addColumn("value", column("string"))
      .createIndex("unique_key", ["key"], { unique: true });
  });
});

export function createSettingsManager(
  // oxlint-disable-next-line no-explicit-any
  queryEngine: AbstractQuery<typeof settingsSchema, any>,
  namespace: string,
) {
  return {
    async get(key: string): Promise<{ id: FragnoId; key: string; value: string } | undefined> {
      const uow = queryEngine
        .createUnitOfWork()
        .find(SETTINGS_TABLE_NAME, (b) =>
          b.whereIndex("unique_key", (eb) => eb("key", "=", `${namespace}.${key}`)),
        );
      const [[result]] = await uow.executeRetrieve();
      return result; // Safe: result can be undefined if key doesn't exist
    },

    async set(key: string, value: string) {
      const uow = queryEngine
        .createUnitOfWork("createSettingsManager#set")
        .find(SETTINGS_TABLE_NAME, (b) =>
          b.whereIndex("unique_key", (eb) => eb("key", "=", `${namespace}.${key}`)),
        );
      const [[existing]] = await uow.executeRetrieve();

      if (existing) {
        uow.update(SETTINGS_TABLE_NAME, existing.id, (b) => b.set({ value }).check());
      } else {
        uow.create(SETTINGS_TABLE_NAME, {
          key: `${namespace}.${key}`,
          value,
        });
      }

      const { success } = await uow.executeMutations();

      if (!success) {
        throw new Error("Failed to set schema version");
      }
    },

    async delete(id: FragnoId) {
      await queryEngine.delete(SETTINGS_TABLE_NAME, id);
    },
  };
}
