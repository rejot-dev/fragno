import { column, idColumn, schema } from "@fragno-dev/db/schema";

import { defineFragment, instantiate } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";

import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";

import { featureFlagDefinitions, featureFlagKeySchema, type FeatureFlagKey } from "./contracts";

const featureFlagsSchema = schema("feature-flags", (builder) =>
  builder.addTable("feature_flag_override", (table) =>
    table.addColumn("id", idColumn()).addColumn("enabled", column("bool")),
  ),
);

function status(key: FeatureFlagKey, override: boolean | null) {
  const definition = featureFlagDefinitions[key];
  return { key, ...definition, override, enabled: override ?? definition.defaultEnabled };
}

const featureFlagsDefinition = defineFragment("feature-flags")
  .extend(withDatabase(featureFlagsSchema))
  .providesBaseService(({ defineService }) =>
    defineService({
      getFlag: function (key: FeatureFlagKey) {
        return this.serviceTx(featureFlagsSchema)
          .retrieve((uow) =>
            uow.findFirst("feature_flag_override", (query) =>
              query.whereIndex("primary", (where) => where("id", "=", key)),
            ),
          )
          .transformRetrieve(([row]) => status(key, row?.enabled ?? null))
          .build();
      },
      listFlags: function () {
        return this.serviceTx(featureFlagsSchema)
          .retrieve((uow) =>
            uow.find("feature_flag_override", (query) => query.whereIndex("primary")),
          )
          .transformRetrieve(([rows]) => {
            const overrides = new Map(rows.map((row) => [row.id.toString(), row.enabled]));
            return featureFlagKeySchema.options.map((key) =>
              status(key, overrides.get(key) ?? null),
            );
          })
          .build();
      },
      setFlag: function ({ key, override }: { key: FeatureFlagKey; override: boolean | null }) {
        return this.serviceTx(featureFlagsSchema)
          .retrieve((uow) =>
            uow.findFirst("feature_flag_override", (query) =>
              query.whereIndex("primary", (where) => where("id", "=", key)),
            ),
          )
          .mutate(({ uow, retrieveResult: [row] }) => {
            if (row && override === null) {
              uow.delete("feature_flag_override", row.id, (mutation) => mutation.check());
            } else if (row && override !== null && row.enabled !== override) {
              uow.update("feature_flag_override", row.id, (mutation) =>
                mutation.set({ enabled: override }).check(),
              );
            } else if (!row && override !== null) {
              uow.checkAbsent("feature_flag_override", "primary", { id: key });
              uow.create("feature_flag_override", { id: key, enabled: override });
            }
            return status(key, override);
          })
          .build();
      },
    }),
  )
  .build();

export function createFeatureFlagsServer(runtime: BackofficeFragmentRuntimeOptions) {
  return instantiate(featureFlagsDefinition)
    .withRoutes([])
    .withOptions({
      databaseAdapter: runtime.adapters.createAdapter({ kind: "feature-flags" }),
      transactionInstrumentation: runtime.transactionInstrumentation,
    })
    .build();
}
