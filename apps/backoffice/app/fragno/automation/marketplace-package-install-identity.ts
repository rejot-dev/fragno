import {
  marketplaceListingIdSchema,
  marketplaceVersionSchema,
} from "@fragno-dev/backoffice-api/v0/marketplace";

import {
  backofficeScopeSinglePathSegment,
  type BackofficeRoutableScope,
} from "@/backoffice-runtime/scope-codec";
import { sha256Hex } from "@/lib/crypto";

/** Package installation is coordinated by the destination's organization Automations object. */
export const MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME = "marketplace-package-install";

/** A package's optional setup workflow is a child of its package installation instance. */
export function marketplaceInstallationWorkflowInstanceId(
  packageInstallWorkflowInstanceId: string,
) {
  return `${packageInstallWorkflowInstanceId}:installation`;
}

/** Installation identity includes the destination folder, not only the listing and version. */
export async function buildMarketplacePackageInstallWorkflowInstanceId(input: {
  targetScope: BackofficeRoutableScope;
  installationRoot: string;
  listingId: string;
  version: string;
}) {
  return `marketplace-package-install-${await sha256Hex(
    new TextEncoder().encode(
      `${backofficeScopeSinglePathSegment(input.targetScope)}\0${input.installationRoot}\0${marketplaceListingIdSchema.parse(input.listingId)}\0${marketplaceVersionSchema.parse(input.version)}`,
    ),
  )}`;
}
