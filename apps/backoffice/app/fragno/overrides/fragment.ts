import { column, idColumn, schema } from "@fragno-dev/db/schema";

import { defineFragment, instantiate } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";

import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";

import type { OverrideKind, StoredOverride } from "./definition";

const OVERRIDE_INDEX = "idx_override_scope_kind_key";

const overridesSchema = schema("overrides", (builder) =>
  builder.addTable("override", (table) =>
    table
      .addColumn("id", idColumn())
      // The path segment of the scope the override is set on.
      .addColumn("scope", column("string"))
      .addColumn("kind", column("string"))
      .addColumn("key", column("string"))
      .addColumn("value", column("json"))
      .createIndex(OVERRIDE_INDEX, ["scope", "kind", "key"], { unique: true }),
  ),
);

type StoredOverrideAddress = { scope: string; kind: OverrideKind; key: string };

const overridesDefinition = defineFragment("overrides")
  .extend(withDatabase(overridesSchema))
  .providesBaseService(({ defineService }) =>
    defineService({
      listOverrides: function (scopes: string[]) {
        return this.serviceTx(overridesSchema)
          .retrieve((uow) =>
            uow.find("override", (query) =>
              query.whereIndex(OVERRIDE_INDEX, (where) => where("scope", "in", scopes)),
            ),
          )
          .transformRetrieve(([rows]): StoredOverride[] =>
            // Only this service writes kinds, so they are trusted.
            rows.map(({ scope, kind, key, value }) => ({
              scope,
              kind: kind as OverrideKind,
              key,
              value,
            })),
          )
          .build();
      },
      setOverride: function ({ value, ...address }: StoredOverrideAddress & { value: unknown }) {
        return this.serviceTx(overridesSchema)
          .retrieve((uow) =>
            uow.findFirst("override", (query) =>
              query.whereIndex(OVERRIDE_INDEX, (where) =>
                where.and(
                  where("scope", "=", address.scope),
                  where("kind", "=", address.kind),
                  where("key", "=", address.key),
                ),
              ),
            ),
          )
          .mutate(({ uow, retrieveResult: [row] }) => {
            if (row) {
              uow.update("override", row.id, (mutation) => mutation.set({ value }).check());
            } else {
              uow.checkAbsent("override", OVERRIDE_INDEX, address);
              uow.create("override", { ...address, value });
            }
          })
          .build();
      },
      clearOverride: function (address: StoredOverrideAddress) {
        return this.serviceTx(overridesSchema)
          .retrieve((uow) =>
            uow.findFirst("override", (query) =>
              query.whereIndex(OVERRIDE_INDEX, (where) =>
                where.and(
                  where("scope", "=", address.scope),
                  where("kind", "=", address.kind),
                  where("key", "=", address.key),
                ),
              ),
            ),
          )
          .mutate(({ uow, retrieveResult: [row] }) => {
            if (row) {
              uow.delete("override", row.id, (mutation) => mutation.check());
            }
          })
          .build();
      },
    }),
  )
  .build();

export function createOverridesServer(runtime: BackofficeFragmentRuntimeOptions) {
  return instantiate(overridesDefinition)
    .withRoutes([])
    .withOptions({
      databaseAdapter: runtime.adapters.createAdapter({ kind: "overrides" }),
      transactionInstrumentation: runtime.transactionInstrumentation,
    })
    .build();
}
