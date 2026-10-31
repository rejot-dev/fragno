import {
  packagesInstallInputSchema,
  packagesInstallResultSchema,
  packagesStatusInputSchema,
  type PackageInstallation,
  type PackageInstallStatus,
  type PackagesImportLegacyInput,
  type PackagesImportLegacyResult,
  type PackageUninstallation,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import {
  backofficeContextScopesEqual,
  type BackofficeOrganizationContextScope,
  backofficeScopeRootOwner,
  isBackofficeRoutableScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import { backofficeOrganizationContextScope } from "@/backoffice-runtime/resolved-scope";
import { marketplaceScopeForVisibility } from "@/fragno/marketplace/owner";

/** Package listing reads the current workspace's installations, not a registry query. */
export type PackagesRuntime = {
  install(
    input: z.output<typeof packagesInstallInputSchema>,
  ): Promise<z.output<typeof packagesInstallResultSchema>>;
  status(input: z.output<typeof packagesStatusInputSchema>): Promise<PackageInstallStatus | null>;
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
  piManagerAvailable,
}: {
  objects: BackofficeObjectRegistry;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
  preferredOrganizationId: string | null;
  piManagerAvailable: boolean;
}): PackagesRuntime {
  const targetScope = execution.scope;
  if (!isBackofficeRoutableScope(targetScope)) {
    throw new Error("Packages runtime requires a destination workspace.");
  }

  const targetAutomations = () => kernel.scoped("AUTOMATIONS", targetScope, objects.automations);

  const installationTarget = () => {
    if (targetScope.kind === "app") {
      throw new Error("Packages cannot be installed into an app's workspace.");
    }
    return targetScope;
  };

  return {
    async install({ visibility, ...input }) {
      const target = installationTarget();
      const owner = backofficeScopeRootOwner(target);
      let workflowScope: BackofficeOrganizationContextScope;
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
        workflowScope = backofficeOrganizationContextScope(organization.organization);
      } else {
        workflowScope = owner;
      }
      // Organization visibility installs from the coordinating organization's own Marketplace.
      const marketplace = marketplaceScopeForVisibility(visibility, workflowScope);
      const result = await kernel
        .scoped("AUTOMATIONS", workflowScope, objects.automations)
        .commands.restartMarketplaceIngestion(
          { ...input, marketplace, targetScope: target },
          { execution: { ...execution, scope: workflowScope }, propagationContext: null },
        );
      return { ...result, installationRoot: input.installationRoot, workflowScope };
    },
    async status({ workflowInstanceId, workflowScope }) {
      const target = installationTarget();
      const owner = backofficeScopeRootOwner(target);
      // A personal workspace installs through whichever organization the installer chose, so the
      // run names it; other workspaces always install through their own organization.
      if (owner.kind !== "user" && !backofficeContextScopesEqual(owner, workflowScope)) {
        throw new BackofficeOperationError(
          "invalid_request",
          `This workspace installs through organization '${owner.orgId}', not '${workflowScope.orgId}'.`,
        );
      }
      // The coordinator answers only for runs into this workspace, which authorizes the read.
      return await kernel
        .scoped("AUTOMATIONS", workflowScope, objects.automations)
        .commands.getMarketplaceIngestionStatus({ workflowInstanceId, targetScope: target });
    },
    async ls() {
      return { installations: await targetAutomations().commands.listPackageInstallations() };
    },
    async get(input) {
      return await targetAutomations().commands.getPackageInstallation(input);
    },
    async uninstall(input) {
      if (!(await targetAutomations().commands.getPackageInstallation(input))) {
        return null;
      }
      // Agents go first: should the rest fail, the installation is still recorded to uninstall again.
      const removedAgents = piManagerAvailable
        ? await kernel
            .scoped("PI_MANAGER", targetScope, objects.piManager)
            .commands.removePackageAgents({ ...input, actors: execution.actors })
        : [];
      const uninstalled = await targetAutomations().commands.uninstallPackage(input);
      return uninstalled && { ...uninstalled, removedAgents };
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
