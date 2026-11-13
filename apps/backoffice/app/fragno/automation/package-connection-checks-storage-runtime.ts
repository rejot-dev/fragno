import type {
  PackageConnectionCheck,
  PackageConnectionResult,
} from "@fragno-dev/backoffice-api/v0/marketplace";

import type { DatabaseServiceContext } from "@fragno-dev/db";

import { automationFragmentSchema } from "./schema";

type PackageConnectionCheckServiceContext = DatabaseServiceContext<Record<string, never>>;

type PackageConnectionCheckRow = {
  id: { externalId: string };
  version: string;
  results: PackageConnectionResult[];
  confirmedAt: Date;
};

function packageConnectionCheckFromRow(row: PackageConnectionCheckRow): PackageConnectionCheck {
  return {
    listingId: row.id.externalId,
    version: row.version,
    results: row.results,
    confirmedAt: row.confirmedAt.toISOString(),
  };
}

export const createPackageConnectionCheckServices = (
  defineService: <TService>(
    service: TService & ThisType<PackageConnectionCheckServiceContext>,
  ) => TService,
) =>
  defineService({
    getPackageConnectionCheck({ listingId }: { listingId: string }) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("package_connection_check", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", listingId)),
          ),
        )
        .transformRetrieve(([row]) => (row ? packageConnectionCheckFromRow(row) : null))
        .build();
    },

    /** Replaces the listing's check with this one, confirmed now. */
    putPackageConnectionCheck({
      listingId,
      version,
      results,
    }: {
      listingId: string;
      version: string;
      results: PackageConnectionResult[];
    }) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("package_connection_check", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", listingId)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing] }) => {
          const values = { version, results, confirmedAt: uow.now() };
          if (existing) {
            uow.update("package_connection_check", existing.id, (b) => b.set(values).check());
          } else {
            uow.create("package_connection_check", { id: listingId, ...values });
          }
        })
        .build();
    },
  });
