import type { DatabaseServiceContext } from "@fragno-dev/db";

import type {
  StoreDeleteArgs,
  StoreGetArgs,
  StoreListArgs,
  StoreSetArgs,
} from "../runtime-tools/automation-types";
import type { AutomationStoreEntry } from "../runtime-tools/families/automations-bindings";
import { automationFragmentSchema } from "./schema";
import {
  automationStoreDeleteResultSchema,
  automationStoreEntrySchema,
  hasSystemCategory,
  validateAutomationStoreVerification,
} from "./store";

export class AutomationStoreProtectedEntryError extends Error {
  constructor(readonly key: string) {
    super(`Store entry '${key}' is protected and cannot be deleted.`);
    this.name = "AutomationStoreProtectedEntryError";
  }
}

type AutomationStoreServiceContext = DatabaseServiceContext<Record<string, never>>;

const normalizeStoreEntry = (entry: unknown): AutomationStoreEntry =>
  automationStoreEntrySchema.parse(entry);

const normalizeStoreEntries = (entries: unknown[]): AutomationStoreEntry[] =>
  entries.map((entry) => normalizeStoreEntry(entry));

const mergeCategoryForUpdate = ({
  existing,
  nextCategory,
}: {
  existing: AutomationStoreEntry;
  nextCategory?: string[];
}) => {
  if (typeof nextCategory === "undefined") {
    return existing.category;
  }

  if (!hasSystemCategory(existing) || nextCategory.includes("system")) {
    return nextCategory;
  }

  return [...nextCategory, "system"];
};

export const createAutomationStoreServices = (
  defineService: <TService>(
    service: TService & ThisType<AutomationStoreServiceContext>,
  ) => TService,
) =>
  defineService({
    listStoreEntries({ prefix, limit }: StoreListArgs = {}) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.find("kv_store", (b) => {
            const query = prefix
              ? b.whereIndex("idx_kv_store_key", (eb) => eb("key", "starts with", prefix))
              : b.whereIndex("primary");
            return limit ? query.pageSize(limit) : query;
          }),
        )
        .transformRetrieve(([entries]) => normalizeStoreEntries(entries))
        .build();
    },

    getStoreEntry({ key }: StoreGetArgs) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("kv_store", (b) =>
            b.whereIndex("idx_kv_store_key", (eb) => eb("key", "=", key)),
          ),
        )
        .transformRetrieve(([entry]) => (entry ? normalizeStoreEntry(entry) : null))
        .build();
    },

    setStoreEntry(args: StoreSetArgs) {
      const { key, value, actor, verification } = args;
      validateAutomationStoreVerification({ value, verification });

      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("kv_store", (b) =>
            b.whereIndex("idx_kv_store_key", (eb) => eb("key", "=", key)),
          ),
        )
        .mutate(({ uow, retrieveResult: [rawExisting] }) => {
          const now = uow.now();

          if (rawExisting) {
            const existing = normalizeStoreEntry(rawExisting);
            const description = "description" in args ? args.description : existing.description;
            const category = mergeCategoryForUpdate({ existing, nextCategory: args.category });

            uow.update("kv_store", rawExisting.id, (b) =>
              b
                .set({
                  key,
                  value,
                  actor,
                  description: description ?? null,
                  category,
                  updatedAt: now,
                })
                .check(),
            );

            return {
              ...existing,
              key,
              value,
              actor,
              description: description ?? null,
              category,
              updatedAt: now,
            };
          }

          const category = args.category ?? [];
          const description = args.description ?? null;
          const createdId = uow.create("kv_store", {
            key,
            value,
            actor,
            description,
            category,
            createdAt: now,
            updatedAt: now,
          });

          return {
            id: createdId.valueOf(),
            key,
            value,
            actor,
            description,
            category,
            createdAt: now,
            updatedAt: now,
          };
        })
        .transform(({ mutateResult }) => normalizeStoreEntry(mutateResult))
        .build();
    },

    deleteStoreEntry({ key }: StoreDeleteArgs) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("kv_store", (b) =>
            b.whereIndex("idx_kv_store_key", (eb) => eb("key", "=", key)),
          ),
        )
        .mutate(({ uow, retrieveResult: [rawExisting] }) => {
          if (!rawExisting) {
            return null;
          }

          const existing = normalizeStoreEntry(rawExisting);
          if (hasSystemCategory(existing)) {
            throw new AutomationStoreProtectedEntryError(key);
          }

          uow.delete("kv_store", rawExisting.id, (b) => b.check());
          return { ok: true as const, key };
        })
        .transform(({ mutateResult }) =>
          mutateResult ? automationStoreDeleteResultSchema.parse(mutateResult) : null,
        )
        .build();
    },
  });
