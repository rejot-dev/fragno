import { marketplacePublishInputSchema } from "@fragno-dev/backoffice-api/v0/marketplace";
import { type MarketplaceOwner } from "@fragno-dev/backoffice-api/v0/marketplace";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { z } from "zod";

import {
  backofficeDeferredExecutionSchema,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { sha256Hex } from "@/lib/crypto";

import { marketplacePackageSnapshotSchema } from "./package-manifest";
import {
  MARKETPLACE_RELEASE_GUARD_PATH,
  marketplaceReleaseSnapshotSchema,
} from "./release-snapshot";

/** Workspace manifests are validated at the author-facing boundary, not in the release publisher. */
export const marketplacePublishPackageInputSchema = marketplacePublishInputSchema
  .omit({ packageRoot: true })
  .extend({ snapshot: marketplacePackageSnapshotSchema });
export type MarketplacePublishPackageInput = z.input<typeof marketplacePublishPackageInputSchema>;

/** Both capture adapters submit resolved releases through this authenticated RPC boundary. */
export const marketplacePublishReleaseInputSchema = z.strictObject({
  release: marketplaceReleaseSnapshotSchema,
  dryRun: z.boolean(),
  skipAuthorCheck: z.boolean(),
  skipVersionCheck: z.boolean(),
});
export type MarketplacePublishReleaseInput = z.output<typeof marketplacePublishReleaseInputSchema>;

/** Original actor provenance survives deferral; short-lived token authority does not. */
const marketplacePackagePublishIntentSchema = z.strictObject({
  release: marketplaceReleaseSnapshotSchema,
  execution: backofficeDeferredExecutionSchema,
  skipAuthorCheck: z.boolean(),
  skipVersionCheck: z.boolean(),
});
export type MarketplacePackagePublishIntent = z.output<
  typeof marketplacePackagePublishIntentSchema
>;

/** Destination revisions, including the publisher-owned guard, survive full workflow restarts. */
export const marketplacePackagePublishRequestSchema = z
  .strictObject({
    workflowInstanceId: z.string().min(1),
    intent: marketplacePackagePublishIntentSchema,
    expectedVersionRevision: z.number().int().nonnegative().nullable(),
    expectedFiles: z.array(
      z.strictObject({
        fileKey: z.string().min(1),
        precondition: z.discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("absent") }),
          z.strictObject({ kind: z.literal("revision"), revision: z.number().int().nonnegative() }),
        ]),
      }),
    ),
  })
  .superRefine((request, context) => {
    const { release } = request.intent;
    const prefix = `${release.version}/`;
    const keys = new Set(request.expectedFiles.map((file) => file.fileKey));
    if (
      keys.size !== request.expectedFiles.length ||
      request.expectedFiles.some((file) => !file.fileKey.startsWith(prefix)) ||
      !keys.has(`${prefix}${MARKETPLACE_RELEASE_GUARD_PATH}`) ||
      release.files.some((file) => !keys.has(`${prefix}${file.relativePath}`))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Marketplace destination revisions must cover every release file and its publishing guard.",
      });
    }
  });
export type MarketplacePackagePublishRequest = z.output<
  typeof marketplacePackagePublishRequestSchema
>;

/** Only the current version's publishing workflow is retained, not historical receipts or artifact locations. */
export type MarketplaceVersionPublishState = {
  state: "publishing" | "published" | "failed";
  workflowInstanceId: string;
  snapshotId: string;
};

/** Release preparation reports durable work without adding workspace-specific result fields. */
export type MarketplacePublishReleaseResult =
  | { state: "preview" }
  | {
      state: "requested";
      workflowCreated: boolean;
      workflowInstanceId: string;
      workflowScope: { kind: "system" };
    }
  | {
      state: "published";
      workflowInstanceId: string;
      workflowScope: { kind: "system" };
    };

export type MarketplacePackagePublishPlan =
  | { state: "new"; expectedVersionRevision: number | null }
  | { state: "requested"; workflowInstanceId: string }
  | { state: "published"; workflowInstanceId: string; expectedVersionRevision: number };

export class MarketplacePublicationAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketplacePublicationAccessError";
  }
}

/** Authorization follows ownership; System coordination never grants organization membership. */
export async function assertMarketplacePublicationAuthority({
  runtime,
  execution,
  owner,
  skipAuthorCheck,
  skipVersionCheck,
}: {
  runtime: BackofficeRuntimeServices;
  execution: BackofficeExecutionContext;
  owner: MarketplaceOwner;
  skipAuthorCheck: boolean;
  skipVersionCheck: boolean;
}): Promise<void> {
  if ((skipAuthorCheck || skipVersionCheck) && execution.scope.kind !== "system") {
    throw new MarketplacePublicationAccessError(
      "Marketplace publishing overrides require System context.",
    );
  }
  await new BackofficeKernel(runtime).assertAuthorized({
    execution,
    operation: BACKOFFICE_PERMISSION.marketplace.publish,
  });
  if (owner.scope.kind === "system") {
    if (execution.scope.kind !== "system") {
      throw new MarketplacePublicationAccessError(
        "System-owned Marketplace releases require System context.",
      );
    }
    return;
  }
  if (owner.scope.kind !== "org") {
    throw new MarketplacePublicationAccessError(
      "Marketplace release publishing supports System and organization ownership.",
    );
  }
  const organizationId = owner.scope.orgId;
  const organizations = await runtime.objects.auth.singleton().commands.getAllOrganizations();
  if (!organizations.some((organization) => organization.id === organizationId)) {
    throw new MarketplacePublicationAccessError(
      "Marketplace publisher organization is no longer available.",
    );
  }
  if (skipAuthorCheck) {
    return;
  }
  const principal = execution.actors.principal;
  if (principal?.scope === "internal" && principal.type === "user") {
    if (
      await runtime.objects.auth
        .singleton()
        .commands.hasOrganizationMember({ organizationId, userId: principal.id })
    ) {
      return;
    }
  } else if (
    (execution.scope.kind === "org" || execution.scope.kind === "project") &&
    execution.scope.orgId === organizationId
  ) {
    return;
  }
  throw new MarketplacePublicationAccessError(
    "Marketplace publication requires membership in the owning organization.",
  );
}

/** Identical authenticated requests against the same destination deduplicate without publication records. */
export async function marketplacePackagePublishWorkflowInstanceId(
  input: Omit<MarketplacePackagePublishRequest, "workflowInstanceId">,
): Promise<string> {
  const { intent, expectedVersionRevision, expectedFiles } = input;
  const identity = [
    intent.release.listingId,
    intent.release.snapshotId,
    // Schema parsing may reorder object keys; hash execution fields in a fixed order.
    [intent.execution.scope, intent.execution.scopeRestriction, intent.execution.actors],
    intent.skipAuthorCheck,
    intent.skipVersionCheck,
    expectedVersionRevision,
    expectedFiles,
  ];
  return `marketplace-package-publish-${await sha256Hex(new TextEncoder().encode(JSON.stringify(identity)))}`;
}
