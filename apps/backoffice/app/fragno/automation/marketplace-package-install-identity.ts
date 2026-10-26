import {
  marketplaceListingIdSchema,
  marketplaceVersionSchema,
  type MarketplaceScope,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import {
  type BackofficeRoutableScope,
  backofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import { sha256Hex } from "@/lib/crypto";

/** Package installation is coordinated by the destination's organization Automations object. */
export const MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME = "marketplace-package-install";

const MARKETPLACE_PACKAGE_INSTALL_INSTANCE_PREFIX = "marketplace-package-install-";
const MARKETPLACE_INSTALLATION_WORKFLOW_SUFFIX = ":installation";

/** A package's optional install workflow is a child of its package installation instance. */
export function marketplaceInstallationWorkflowInstanceId(
  packageInstallWorkflowInstanceId: string,
) {
  return `${packageInstallWorkflowInstanceId}${MARKETPLACE_INSTALLATION_WORKFLOW_SUFFIX}`;
}

/** Whether a codemode instance is a package's install workflow, which decides its settings. */
export function isMarketplaceInstallationWorkflowInstanceId(instanceId: string) {
  return (
    instanceId.startsWith(MARKETPLACE_PACKAGE_INSTALL_INSTANCE_PREFIX) &&
    instanceId.endsWith(MARKETPLACE_INSTALLATION_WORKFLOW_SUFFIX)
  );
}

/** Installation identity includes the source Marketplace and destination folder, not only the listing and version. */
export async function buildMarketplacePackageInstallWorkflowInstanceId(input: {
  marketplace: MarketplaceScope;
  targetScope: BackofficeRoutableScope;
  installationRoot: string;
  listingId: string;
  version: string;
}) {
  return `${MARKETPLACE_PACKAGE_INSTALL_INSTANCE_PREFIX}${await sha256Hex(
    new TextEncoder().encode(
      `${backofficeScopePathSegment(input.marketplace)}\0${backofficeScopePathSegment(input.targetScope)}\0${input.installationRoot}\0${marketplaceListingIdSchema.parse(input.listingId)}\0${marketplaceVersionSchema.parse(input.version)}`,
    ),
  )}`;
}
