import type { PackageInstallation } from "@fragno-dev/backoffice-api/v0/marketplace";

import type { DatabaseServiceContext } from "@fragno-dev/db";

import { automationFragmentSchema } from "./schema";

type PackageInstallationServiceContext = DatabaseServiceContext<Record<string, never>>;

/**
 * An installation and the install run that last wrote it; installations recorded another way, such
 * as by importing a legacy lock, have the empty operation.
 */
export type PackageInstallationRecord = {
  installation: PackageInstallation;
  operation: string;
};

/** The installation changed since the writer read it, so the write would undo another one. */
export class PackageInstallationChangedError extends Error {
  constructor(listingId: string) {
    super(
      `Package '${listingId}' was installed or uninstalled elsewhere while this ran. Try again.`,
    );
    this.name = "PackageInstallationChangedError";
  }
}

type PackageInstallationRow = {
  id: { externalId: string };
  operation: string;
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

    getPackageInstallationRecord({ listingId }: { listingId: string }) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("package_installation", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", listingId)),
          ),
        )
        .transformRetrieve(([row]): PackageInstallationRecord | null =>
          row ? { installation: packageInstallationFromRow(row), operation: row.operation } : null,
        )
        .build();
    },

    /**
     * Records the installation as the operation's. Throws `PackageInstallationChangedError` unless
     * the installation is still as the operation read it, written by `expectedOperation` or absent
     * when that is null, or the operation already wrote it.
     */
    putPackageInstallation({
      installation,
      operation,
      expectedOperation,
    }: {
      installation: PackageInstallation;
      operation: string;
      expectedOperation: string | null;
    }) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("package_installation", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", installation.listingId)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing] }) => {
          const current = existing?.operation ?? null;
          if (current !== expectedOperation && current !== operation) {
            throw new PackageInstallationChangedError(installation.listingId);
          }
          const values = {
            marketplace: installation.marketplace,
            version: installation.version,
            installationRoot: installation.installationRoot,
            permissions: installation.permissions,
            settings: installation.settings,
            operation,
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

    /**
     * Throws `PackageInstallationChangedError` when an install run wrote the installation since the
     * caller read it as `expectedOperation`'s.
     */
    deletePackageInstallation({
      listingId,
      expectedOperation,
    }: {
      listingId: string;
      expectedOperation: string;
    }) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("package_installation", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", listingId)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing] }) => {
          if (!existing || existing.operation !== expectedOperation) {
            throw new PackageInstallationChangedError(listingId);
          }
          uow.delete("package_installation", existing.id, (b) => b.check());
        })
        .build();
    },
  });
