import {
  packagesInstallInputSchema,
  packagesInstallResultSchema,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import {
  MARKETPLACE_LOCK_PATH,
  marketplaceLockSchema,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import { z } from "zod";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { isBackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
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
    async install(input) {
      let organizationId: string;
      if (targetScope.kind === "user") {
        const me = await objects.auth.singleton().commands.getBackofficeMe({
          userId: targetScope.userId,
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
        organizationId = targetScope.orgId;
      }
      const workflowScope = { kind: "org" as const, orgId: organizationId };
      const result = await kernel
        .scoped("AUTOMATIONS", workflowScope, objects.automations)
        .commands.restartMarketplaceIngestion(
          { ...input, targetScope },
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
