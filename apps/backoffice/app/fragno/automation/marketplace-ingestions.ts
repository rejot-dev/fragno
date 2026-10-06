import { z } from "zod";

import {
  backofficeOrganizationScopeSchema,
  backofficeProjectScopeSchema,
  backofficeUserScopeSchema,
} from "@/backoffice-runtime/context-schema";
import type { BackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import {
  marketplaceListingIdSchema,
  marketplaceVersionSchema,
  type MarketplaceArtifactManifest,
} from "@/fragno/marketplace/contracts";
import { marketplaceInstallationRootSchema } from "@/fragno/marketplace/marketplace-lock";

import { backofficeWorkflowActorMetadataSchema } from "./actors";

const marketplaceIngestionTargetScopeSchema = z.discriminatedUnion("kind", [
  backofficeOrganizationScopeSchema,
  backofficeProjectScopeSchema,
  backofficeUserScopeSchema,
]);

export const marketplaceIngestionRequestInputSchema = z.object({
  targetScope: marketplaceIngestionTargetScopeSchema,
  installationRoot: marketplaceInstallationRootSchema,
  listingId: marketplaceListingIdSchema,
  version: marketplaceVersionSchema.optional(),
});

export type MarketplaceIngestionRequestInput = z.infer<
  typeof marketplaceIngestionRequestInputSchema
>;

export const marketplaceIngestionWorkflowInputSchema =
  marketplaceIngestionRequestInputSchema.extend({
    version: marketplaceVersionSchema,
    metadata: backofficeWorkflowActorMetadataSchema,
  });

export class MarketplaceIngestionTargetAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketplaceIngestionTargetAccessError";
  }
}

export class MarketplaceIngestionArtifactUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketplaceIngestionArtifactUnavailableError";
  }
}

export const assertMarketplaceIngestionTargetBelongsToOrganization = (input: {
  organizationId: string;
  targetScope: BackofficeRoutableScope;
}): void => {
  if (
    (input.targetScope.kind === "org" || input.targetScope.kind === "project") &&
    input.targetScope.orgId !== input.organizationId
  ) {
    throw new MarketplaceIngestionTargetAccessError(
      "Marketplace ingestion target belongs to another organization.",
    );
  }
};

export const assertMarketplaceIngestionTargetAccessible = async (input: {
  organizationId: string;
  targetScope: BackofficeRoutableScope;
  projectExists: (projectId: string) => Promise<boolean>;
  organizationHasMember: (userId: string) => Promise<boolean>;
}): Promise<void> => {
  assertMarketplaceIngestionTargetBelongsToOrganization(input);

  if (
    input.targetScope.kind === "project" &&
    !(await input.projectExists(input.targetScope.projectId))
  ) {
    throw new MarketplaceIngestionTargetAccessError(
      "Marketplace ingestion project target was not found.",
    );
  }

  if (
    input.targetScope.kind === "user" &&
    !(await input.organizationHasMember(input.targetScope.userId))
  ) {
    throw new MarketplaceIngestionTargetAccessError(
      "Marketplace ingestion user target is not a member of the organization.",
    );
  }
};

export const resolveMarketplaceIngestionArtifactVersion = (
  manifest: MarketplaceArtifactManifest | null,
  requestedVersion: string | undefined,
): {
  manifest: MarketplaceArtifactManifest;
  version: string;
} => {
  if (manifest?.listingStatus !== "published") {
    throw new MarketplaceIngestionArtifactUnavailableError("Marketplace listing is not published.");
  }

  const version = requestedVersion ?? manifest.versions[0];
  const selected = manifest.versions.find((candidate) => candidate === version);
  if (!selected) {
    throw new MarketplaceIngestionArtifactUnavailableError(
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

/** Installation callers share the existing workflow restart result contract. */
export const marketplaceIngestionRestartResultSchema = z.object({
  listingId: marketplaceListingIdSchema,
  version: marketplaceVersionSchema,
  workflowInstanceId: z.string().min(1),
  action: z.enum(["created", "restarted", "unchanged"]),
  workflowStatus: z.enum(["active", "paused", "errored", "terminated", "complete", "waiting"]),
});

export type MarketplaceIngestionRestartResult = z.infer<
  typeof marketplaceIngestionRestartResultSchema
>;
