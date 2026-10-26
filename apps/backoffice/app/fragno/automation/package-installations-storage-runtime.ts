import type { PackageInstallation } from "@fragno-dev/backoffice-api/v0/marketplace";

import type { DatabaseServiceContext } from "@fragno-dev/db";

import { automationFragmentSchema } from "./schema";

type PackageInstallationServiceContext = DatabaseServiceContext<Record<string, never>>;

type PackageInstallationRow = {
  id: { externalId: string };
  marketplace: PackageInstallation["marketplace"];
  version: string;
  installationRoot: string;
  permissions: PackageInstallation["permissions"];
  settings: PackageInstallation["settings"];
};

function packageInstallationFromRow(row: PackageInstallationRow): PackageInstallation {
  return {
    marketplace: row.marketplace,
    listingId: row.id.externalId,
    version: row.version,
    installationRoot: row.installationRoot,
    permissions: row.permissions,
    settings: row.settings,
  };
}

export const createPackageInstallationServices = (
  defineService: <TService>(
    service: TService & ThisType<PackageInstallationServiceContext>,
  ) => TService,
) =>
  defineService({
    listPackageInstallations() {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) => uow.find("package_installation", (b) => b.whereIndex("primary")))
        .transformRetrieve(([rows]) => rows.map(packageInstallationFromRow))
        .build();
    },

    getPackageInstallation({ listingId }: { listingId: string }) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("package_installation", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", listingId)),
          ),
        )
        .transformRetrieve(([row]) => (row ? packageInstallationFromRow(row) : null))
        .build();
    },

    putPackageInstallation(installation: PackageInstallation) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("package_installation", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", installation.listingId)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing] }) => {
          const values = {
            marketplace: installation.marketplace,
            version: installation.version,
            installationRoot: installation.installationRoot,
            permissions: installation.permissions,
            settings: installation.settings,
            updatedAt: uow.now(),
          };
          if (existing) {
            uow.update("package_installation", existing.id, (b) => b.set(values).check());
          } else {
            uow.create("package_installation", {
              id: installation.listingId,
              ...values,
              createdAt: uow.now(),
            });
          }
        })
        .build();
    },

    /** Records an installation unless the listing already has one; returns whether it did. */
    createPackageInstallationIfAbsent(installation: PackageInstallation) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("package_installation", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", installation.listingId)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing] }) => {
          if (existing) {
            return false;
          }
          uow.create("package_installation", {
            id: installation.listingId,
            marketplace: installation.marketplace,
            version: installation.version,
            installationRoot: installation.installationRoot,
            permissions: installation.permissions,
            settings: installation.settings,
            createdAt: uow.now(),
            updatedAt: uow.now(),
          });
          return true;
        })
        .build();
    },

    deletePackageInstallation({ listingId }: { listingId: string }) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("package_installation", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", listingId)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing] }) => {
          if (existing) {
            uow.delete("package_installation", existing.id, (b) => b.check());
          }
        })
        .build();
    },
  });
