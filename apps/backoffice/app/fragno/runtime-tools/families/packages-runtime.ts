import {
  packagesInstallInputSchema,
  packagesInstallResultSchema,
  type PackageInstallation,
  type PackagesImportLegacyInput,
  type PackagesImportLegacyResult,
  type PackageUninstallation,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import {
  backofficeScopeRootOwner,
  isBackofficeRoutableScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import { marketplaceScopeForVisibility } from "@/fragno/marketplace/owner";

/** Package listing reads the current workspace's installations, not a registry query. */
export type PackagesRuntime = {
  install(
    input: z.output<typeof packagesInstallInputSchema>,
  ): Promise<z.output<typeof packagesInstallResultSchema>>;
  ls(): Promise<{ installations: PackageInstallation[] }>;
  get(input: { listingId: string }): Promise<PackageInstallation | null>;
  uninstall(input: { listingId: string }): Promise<PackageUninstallation | null>;
  importLegacy(input: PackagesImportLegacyInput): Promise<PackagesImportLegacyResult>;
};

/** Preserve the UI installation flow while keeping organization coordination separate from destination scope. */
export function createPackagesRuntime({
  objects,
  kernel,
  execution,
  preferredOrganizationId,
}: {
  objects: BackofficeObjectRegistry;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
  preferredOrganizationId: string | null;
}): PackagesRuntime {
  const targetScope = execution.scope;
  if (!isBackofficeRoutableScope(targetScope)) {
    throw new Error("Packages runtime requires a destination workspace.");
  }

  const targetAutomations = () => kernel.scoped("AUTOMATIONS", targetScope, objects.automations);

  return {
    async install({ visibility, ...input }) {
      if (targetScope.kind === "app") {
        throw new Error("Packages cannot be installed into an app's workspace.");
      }
      const owner = backofficeScopeRootOwner(targetScope);
      let organizationId: string;
      // A user's workspace installs through one of the user's organizations.
      if (owner.kind === "user") {
        const me = await objects.auth.singleton().commands.getBackofficeMe({
          userId: owner.userId,
          activeOrganizationId: preferredOrganizationId,
        });
        const organization =
          me?.organizations.find(
            ({ organization }) => organization.id === me.activeOrganization?.organization.id,
          ) ?? me?.organizations[0];
        if (!organization) {
          throw new Error("Join an organization to install this automation.");
        }
        organizationId = organization.organization.id;
      } else {
        organizationId = owner.orgId;
      }
      const workflowScope = { kind: "org" as const, orgId: organizationId };
      // Organization visibility installs from the coordinating organization's own Marketplace.
      const marketplace = marketplaceScopeForVisibility(visibility, workflowScope);
      const result = await kernel
        .scoped("AUTOMATIONS", workflowScope, objects.automations)
        .commands.restartMarketplaceIngestion(
          { ...input, marketplace, targetScope },
          { execution: { ...execution, scope: workflowScope }, propagationContext: null },
        );
      return { ...result, installationRoot: input.installationRoot, workflowScope };
    },
    async ls() {
      return { installations: await targetAutomations().commands.listPackageInstallations() };
    },
    async get(input) {
      return await targetAutomations().commands.getPackageInstallation(input);
    },
    async uninstall(input) {
      return await targetAutomations().commands.uninstallPackage(input);
    },
    async importLegacy(input) {
      const outcome = await targetAutomations().commands.importLegacyPackageInstallations(input);
      if (!outcome.ok) {
        throw new BackofficeOperationError("invalid_request", outcome.message);
      }
      return outcome.result;
    },
  };
}
