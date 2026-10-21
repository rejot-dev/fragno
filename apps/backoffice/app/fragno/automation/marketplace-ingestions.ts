import {
  marketplaceIngestionRequestInputSchema,
  marketplaceVersionSchema,
  type MarketplaceIngestionTargetScope,
  type MarketplaceScope,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import {
  backofficeScopeOrganization,
  backofficeScopeRootOwner,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import { type MarketplaceListingStorage } from "@/fragno/marketplace/contracts";

import { backofficeWorkflowActorMetadataSchema } from "./actors";

export const marketplaceIngestionWorkflowInputSchema = z.lazy(() =>
  marketplaceIngestionRequestInputSchema._zod.innerType.extend({
    version: marketplaceVersionSchema,
    metadata: backofficeWorkflowActorMetadataSchema,
  }),
);

export class MarketplaceIngestionTargetAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketplaceIngestionTargetAccessError";
  }
}

export class MarketplaceIngestionPackageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketplaceIngestionPackageUnavailableError";
  }
}

export const assertMarketplaceIngestionTargetBelongsToOrganization = (input: {
  organizationId: string;
  targetScope: MarketplaceIngestionTargetScope;
}): void => {
  const targetOrganization = backofficeScopeOrganization(input.targetScope);
  if (targetOrganization && targetOrganization.orgId !== input.organizationId) {
    throw new MarketplaceIngestionTargetAccessError(
      "Marketplace ingestion target belongs to another organization.",
    );
  }
};

/** Organizations install from the public Marketplace or their own, never another organization's. */
export const assertMarketplaceIngestionSourceAccessible = (input: {
  organizationId: string;
  marketplace: MarketplaceScope;
}): void => {
  if (input.marketplace.kind === "org" && input.marketplace.orgId !== input.organizationId) {
    throw new MarketplaceIngestionTargetAccessError(
      "Marketplace ingestion source belongs to another organization.",
    );
  }
};

/**
 * An installation target answers to its root owner: the coordinating organization itself, or one of
 * its members. A project must exist in its owner's store. App workspaces are not install targets.
 */
export const assertMarketplaceIngestionTargetAccessible = async (input: {
  organizationId: string;
  targetScope: MarketplaceIngestionTargetScope;
  projectExists: (
    project: Extract<MarketplaceIngestionTargetScope, { kind: "project" }>,
  ) => Promise<boolean>;
  organizationHasMember: (userId: string) => Promise<boolean>;
}): Promise<void> => {
  const { targetScope } = input;
  if (targetScope.kind === "project" && targetScope.owner.kind === "app") {
    throw new MarketplaceIngestionTargetAccessError(
      "Marketplace ingestion cannot target an app's workspace.",
    );
  }
  assertMarketplaceIngestionTargetBelongsToOrganization(input);

  const owner = backofficeScopeRootOwner(targetScope);
  if (owner.kind === "user" && !(await input.organizationHasMember(owner.userId))) {
    throw new MarketplaceIngestionTargetAccessError(
      "Marketplace ingestion user target is not a member of the organization.",
    );
  }

  if (targetScope.kind === "project" && !(await input.projectExists(targetScope))) {
    throw new MarketplaceIngestionTargetAccessError(
      "Marketplace ingestion project target was not found.",
    );
  }
};

export const resolveMarketplaceIngestionPackageVersion = (
  manifest: MarketplaceListingStorage | null,
  requestedVersion: string | undefined,
): {
  manifest: MarketplaceListingStorage;
  version: string;
} => {
  if (manifest?.listingStatus !== "published") {
    throw new MarketplaceIngestionPackageUnavailableError("Marketplace listing is not published.");
  }

  const version = requestedVersion ?? manifest.versions[0];
  const selected = manifest.versions.find((candidate) => candidate === version);
  if (!selected) {
    throw new MarketplaceIngestionPackageUnavailableError(
      `Marketplace version '${requestedVersion ?? "latest"}' is not available.`,
    );
  }

  return { manifest, version: selected };
};

type MarketplaceIngestionRequestIdentity = {
  listingId: string;
  version: string;
  workflowInstanceId: string;
};

export type MarketplaceIngestionRequestResult = MarketplaceIngestionRequestIdentity &
  (
    | { state: "ingested" }
    | { state: "requested"; workflowStatus: "active" }
    | { state: "pending"; workflowStatus: "active" | "waiting" | "paused" }
    | {
        state: "failed";
        workflowStatus: "errored" | "terminated" | "complete";
        error: { name: string; message: string };
      }
  );
