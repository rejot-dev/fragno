import { isUniqueConstraintError, type HookContext } from "@fragno-dev/db";

import type {
  StoreDeleteArgs,
  StoreGetArgs,
  StoreSetArgs,
} from "../runtime-tools/automation-types";
import type {
  AutomationStoreDeleteResult,
  AutomationStoreEntry,
  AutomationStoreRuntime,
} from "../runtime-tools/families/automations-bindings";
import { automationFragmentSchema } from "./schema";
import { automationStoreDeleteResultSchema, automationStoreEntrySchema } from "./store";

export type { AutomationStoreDeleteResult, AutomationStoreEntry, AutomationStoreRuntime };

export type AutomationStoreStorageContext = Pick<HookContext, "handlerTx">;

type AutomationStoreRetrieveScope = Parameters<
  Parameters<ReturnType<AutomationStoreStorageContext["handlerTx"]>["retrieve"]>[0]
>[0];

const findStoreEntryByKey =
  (key: string) =>
  ({ forSchema }: AutomationStoreRetrieveScope) =>
    forSchema(automationFragmentSchema).findFirst("kv_store", (b) =>
      b.whereIndex("idx_kv_store_key", (eb) => eb("key", "=", key)),
    );

export const listAutomationStoreEntries = async (
  context: AutomationStoreStorageContext,
): Promise<AutomationStoreEntry[]> =>
  await context
    .handlerTx()
    .retrieve(({ forSchema }) =>
      forSchema(automationFragmentSchema).find("kv_store", (b) => b.whereIndex("primary")),
    )
    .transformRetrieve(([entries]) =>
      entries.map((entry) => automationStoreEntrySchema.parse(entry)),
    )
    .execute();

export const getAutomationStoreEntry = async (
  context: AutomationStoreStorageContext,
  { key }: StoreGetArgs,
): Promise<AutomationStoreEntry | null> =>
  await context
    .handlerTx()
    .retrieve(findStoreEntryByKey(key))
    .transformRetrieve(([entry]) => (entry ? automationStoreEntrySchema.parse(entry) : null))
    .execute();

export const setAutomationStoreEntry = async (
  context: AutomationStoreStorageContext,
  { key, value }: StoreSetArgs,
): Promise<AutomationStoreEntry> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await context
        .handlerTx()
        .retrieve(findStoreEntryByKey(key))
        .mutate(({ forSchema, retrieveResult: [existing] }) => {
          const uow = forSchema(automationFragmentSchema);
          const now = uow.now();

          if (existing) {
            uow.update("kv_store", existing.id, (b) =>
              b
                .set({
                  key,
                  value,
                  updatedAt: now,
                })
                .check(),
            );

            return {
              ...existing,
              key,
              value,
              updatedAt: now,
            };
          }

          const createdId = uow.create("kv_store", {
            key,
            value,
            createdAt: now,
            updatedAt: now,
          });

          return {
            id: createdId.valueOf(),
            key,
            value,
            createdAt: now,
            updatedAt: now,
          };
        })
        .transform(({ mutateResult }) => automationStoreEntrySchema.parse(mutateResult))
        .execute();
    } catch (error) {
      if (attempt === 0 && isUniqueConstraintError(error)) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("Failed to set automation store entry after retrying a concurrent insert.");
};

export const deleteAutomationStoreEntry = async (
  context: AutomationStoreStorageContext,
  { key }: StoreDeleteArgs,
): Promise<AutomationStoreDeleteResult | null> =>
  await context
    .handlerTx()
    .retrieve(findStoreEntryByKey(key))
    .mutate(({ forSchema, retrieveResult: [existing] }) => {
      if (!existing) {
        return null;
      }

      forSchema(automationFragmentSchema).delete("kv_store", existing.id, (b) => b.check());
      return { ok: true as const, key };
    })
    .transform(({ mutateResult }) =>
      mutateResult ? automationStoreDeleteResultSchema.parse(mutateResult) : null,
    )
    .execute();

export const createAutomationStoreRuntime = ({
  get,
  set,
  delete: deleteEntry,
}: AutomationStoreRuntime): AutomationStoreRuntime => ({ get, set, delete: deleteEntry });

export const createStorageBackedAutomationStoreRuntime = ({
  hookContext,
}: {
  hookContext: AutomationStoreStorageContext;
}): AutomationStoreRuntime =>
  createAutomationStoreRuntime({
    get: async (args) => getAutomationStoreEntry(hookContext, args),
    set: async (args) => setAutomationStoreEntry(hookContext, args),
    delete: async (args) => deleteAutomationStoreEntry(hookContext, args),
  });
