import type { DatabaseServiceContext } from "@fragno-dev/db";

import type {
  StoreDeleteArgs,
  StoreGetArgs,
  StoreListArgs,
  StoreSetArgs,
} from "../runtime-tools/automation-types";
import { automationFragmentSchema } from "./schema";
import { validateAutomationStoreVerification } from "./store";

type AutomationStoreServiceContext = DatabaseServiceContext<Record<string, never>>;

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
        .transformRetrieve(([entries]) => entries)
        .build();
    },

    getStoreEntry({ key }: StoreGetArgs) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("kv_store", (b) =>
            b.whereIndex("idx_kv_store_key", (eb) => eb("key", "=", key)),
          ),
        )
        .transformRetrieve(([entry]) => entry ?? null)
        .build();
    },

    setStoreEntry(args: StoreSetArgs) {
      const { key, value, verification } = args;
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
            const description = "description" in args ? args.description : rawExisting.description;
            const category = args.category ?? rawExisting.category ?? [];

            uow.update("kv_store", rawExisting.id, (b) =>
              b
                .set({
                  key,
                  value,
                  description: description ?? null,
                  category,
                  updatedAt: now,
                })
                .check(),
            );

            return {
              id: rawExisting.id.valueOf(),
              key,
              value,
              description: description ?? null,
              category,
            };
          }

          const category = args.category ?? [];
          const description = args.description ?? null;
          const createdId = uow.create("kv_store", {
            key,
            value,
            description,
            category,
            createdAt: now,
            updatedAt: now,
          });

          return {
            id: createdId.valueOf(),
            key,
            value,
            description,
            category,
          };
        })
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

          uow.delete("kv_store", rawExisting.id, (b) => b.check());
          return { ok: true as const, key };
        })
        .build();
    },
  });
