import {
  packagesInstallInputSchema,
  packagesInstallResultSchema,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import {
  MARKETPLACE_LOCK_PATH,
  marketplaceLockSchema,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import {
  backofficeScopeRootOwner,
  isBackofficeRoutableScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { marketplaceScopeForVisibility } from "@/fragno/marketplace/owner";
import { UPLOAD_PROVIDER_DATABASE } from "@/fragno/upload";

/** Package listing is the current workspace's successful-installation lock, not a registry query. */
export type PackagesRuntime = {
  install(
    input: z.output<typeof packagesInstallInputSchema>,
  ): Promise<z.output<typeof packagesInstallResultSchema>>;
  ls(): Promise<z.output<typeof marketplaceLockSchema>>;
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
      const url = new URL("https://upload.internal/api/upload/files/by-key/content");
      url.searchParams.set("provider", UPLOAD_PROVIDER_DATABASE);
      url.searchParams.set("key", MARKETPLACE_LOCK_PATH.slice("/workspace/".length));
      const response = await kernel
        .scoped("UPLOAD", targetScope, objects.upload)
        .http.fetch(new Request(url));
      if (response.status === 404) {
        return { entries: [] };
      }
      if (!response.ok) {
        throw new Error(`Packages lock file could not be read (${response.status}).`);
      }
      const lock = marketplaceLockSchema.safeParse(await response.json().catch(() => null));
      if (!lock.success) {
        throw new Error(`Marketplace lock file '${MARKETPLACE_LOCK_PATH}' is invalid.`);
      }
      return lock.data;
    },
  };
}
