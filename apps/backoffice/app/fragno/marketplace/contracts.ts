import {
  MARKETPLACE_DATABASE_ID_MAX_LENGTH,
  MARKETPLACE_DEFAULT_PAGE_SIZE,
  MARKETPLACE_MAX_PAGE_SIZE,
  marketplaceListingIdSchema,
  marketplaceListingMetadataSchema,
  marketplaceOwnerSchema,
  marketplaceOwnerScopeSchema,
  marketplacePublicListingSchema,
  marketplaceSlugSchema,
  marketplaceVersionPageFields,
  marketplaceVersionSchema,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import { z } from "zod";

import { marketplaceListingId, marketplaceVersionId } from "./owner";

export const MARKETPLACE_LATEST_VERSIONS_MAX_IDS = 500;
export const marketplaceListingStatusSchema = z.enum(["draft", "published", "archived"]);
export type MarketplaceListingStatus = z.infer<typeof marketplaceListingStatusSchema>;

export const marketplaceVersionStatusSchema = z.enum(["draft", "published"]);
export type MarketplaceVersionStatus = z.infer<typeof marketplaceVersionStatusSchema>;

const marketplaceVersionIdentityFitsDatabase = (input: {
  listingId: string;
  version: string;
}): boolean => marketplaceVersionId(input).length <= MARKETPLACE_DATABASE_ID_MAX_LENGTH;

export const marketplaceCreateDraftListingInputSchema = z
  .object({
    owner: marketplaceOwnerSchema,
    slug: marketplaceSlugSchema,
    version: marketplaceVersionSchema,
    metadata: marketplaceListingMetadataSchema,
  })
  .refine((input) => {
    const listingId = marketplaceListingId({
      ownerScope: input.owner.scope,
      slug: input.slug,
    });
    return marketplaceVersionIdentityFitsDatabase({ listingId, version: input.version });
  }, "The owner, slug, and version produce a marketplace id longer than 128 characters.");

export type MarketplaceCreateDraftListingInput = z.infer<
  typeof marketplaceCreateDraftListingInputSchema
>;

export const marketplaceStaticEntrySchema = marketplaceCreateDraftListingInputSchema;
export type MarketplaceStaticEntry = z.infer<typeof marketplaceStaticEntrySchema>;

export const marketplaceInsertStaticEntriesInputSchema = z.object({
  entries: z
    .array(marketplaceStaticEntrySchema)
    .min(1)
    .max(100)
    .refine(
      (entries) =>
        new Set(
          entries.map((entry) =>
            marketplaceListingId({ ownerScope: entry.owner.scope, slug: entry.slug }),
          ),
        ).size === entries.length,
      "Static marketplace entries must contain at most one version per owner-scoped listing.",
    ),
});

export type MarketplaceInsertStaticEntriesInput = z.infer<
  typeof marketplaceInsertStaticEntriesInputSchema
>;

export const marketplaceStaticEntryIdentitySchema = z.object({
  listingId: marketplaceListingIdSchema,
  slug: marketplaceSlugSchema,
  version: marketplaceVersionSchema,
});

export type MarketplaceStaticEntryIdentity = z.infer<typeof marketplaceStaticEntryIdentitySchema>;

export const marketplaceInsertStaticEntriesResultSchema = z.object({
  inserted: z.array(marketplaceStaticEntryIdentitySchema),
  skipped: z.array(marketplaceStaticEntryIdentitySchema),
});

export type MarketplaceInsertStaticEntriesResult = z.infer<
  typeof marketplaceInsertStaticEntriesResultSchema
>;

export const marketplaceAddDraftVersionInputSchema = z
  .object({
    owner: marketplaceOwnerSchema,
    listingId: marketplaceListingIdSchema,
    version: marketplaceVersionSchema,
  })
  .refine(
    marketplaceVersionIdentityFitsDatabase,
    "The listing and version produce a marketplace id longer than 128 characters.",
  );

export type MarketplaceAddDraftVersionInput = z.infer<typeof marketplaceAddDraftVersionInputSchema>;

export const marketplaceUpdateListingInputSchema = z.object({
  owner: marketplaceOwnerSchema,
  listingId: marketplaceListingIdSchema,
  metadata: marketplaceListingMetadataSchema,
});

export type MarketplaceUpdateListingInput = z.infer<typeof marketplaceUpdateListingInputSchema>;

export const marketplacePublishVersionInputSchema = z
  .object({
    owner: marketplaceOwnerSchema,
    listingId: marketplaceListingIdSchema,
    version: marketplaceVersionSchema,
  })
  .refine(
    marketplaceVersionIdentityFitsDatabase,
    "The listing and version produce a marketplace id longer than 128 characters.",
  );

export type MarketplacePublishVersionInput = z.infer<typeof marketplacePublishVersionInputSchema>;

export const marketplaceArtifactManifestInputSchema = z.object({
  listingId: marketplaceListingIdSchema,
});

export type MarketplaceArtifactManifestInput = z.infer<
  typeof marketplaceArtifactManifestInputSchema
>;

export const marketplaceLatestPublishedVersionsInputSchema = z.object({
  listingIds: z
    .array(marketplaceListingIdSchema)
    .min(1)
    .max(MARKETPLACE_LATEST_VERSIONS_MAX_IDS)
    .refine(
      (listingIds) => new Set(listingIds).size === listingIds.length,
      "Marketplace listing ids must be unique.",
    ),
});

export type MarketplaceLatestPublishedVersionsInput = z.infer<
  typeof marketplaceLatestPublishedVersionsInputSchema
>;

export type MarketplaceLatestPublishedVersions = Record<string, string | null>;

export const marketplaceArtifactManifestSchema = z.object({
  listingId: marketplaceListingIdSchema,
  slug: marketplaceSlugSchema,
  listingStatus: marketplaceListingStatusSchema,
  uploadName: z.string(),
  versions: z.array(marketplaceVersionSchema),
});

export type MarketplaceArtifactManifest = z.infer<typeof marketplaceArtifactManifestSchema>;

const marketplaceStaticPublicationIdentitySchema = z.object({
  listingId: marketplaceListingIdSchema,
  slug: marketplaceSlugSchema,
  version: marketplaceVersionSchema,
  workflowInstanceId: z.string(),
});

export const marketplaceStaticPublicationEntryResultSchema = z.discriminatedUnion("state", [
  marketplaceStaticPublicationIdentitySchema.omit({ workflowInstanceId: true }).extend({
    state: z.literal("published"),
  }),
  marketplaceStaticPublicationIdentitySchema.extend({
    state: z.literal("requested"),
    workflowStatus: z.literal("active"),
  }),
  marketplaceStaticPublicationIdentitySchema.extend({
    state: z.literal("pending"),
    workflowStatus: z.enum(["active", "waiting", "paused"]),
  }),
  marketplaceStaticPublicationIdentitySchema.extend({
    state: z.literal("failed"),
    workflowStatus: z.enum(["errored", "terminated", "complete"]),
    error: z.object({
      name: z.string(),
      message: z.string(),
    }),
  }),
]);

export type MarketplaceStaticPublicationEntryResult = z.infer<
  typeof marketplaceStaticPublicationEntryResultSchema
>;

export const marketplaceStaticPublicationResultSchema = z.object({
  publications: z.array(marketplaceStaticPublicationEntryResultSchema),
});

export type MarketplaceStaticPublicationResult = z.infer<
  typeof marketplaceStaticPublicationResultSchema
>;

export const marketplaceArchiveListingInputSchema = z.object({
  owner: marketplaceOwnerSchema,
  listingId: marketplaceListingIdSchema,
});

export type MarketplaceArchiveListingInput = z.infer<typeof marketplaceArchiveListingInputSchema>;

export const marketplaceOwnedListingPageInputSchema = z.object({
  ownerScope: marketplaceOwnerScopeSchema,
  status: marketplaceListingStatusSchema.optional(),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(MARKETPLACE_MAX_PAGE_SIZE)
    .default(MARKETPLACE_DEFAULT_PAGE_SIZE),
  cursor: z.string().trim().min(1).optional(),
});

export type MarketplaceOwnedListingPageInput = z.input<
  typeof marketplaceOwnedListingPageInputSchema
>;

export const marketplaceOwnedListingInputSchema = z.object({
  listingId: marketplaceListingIdSchema,
  ownerScope: marketplaceOwnerScopeSchema,
  ...marketplaceVersionPageFields,
});

export type MarketplaceOwnedListingInput = z.input<typeof marketplaceOwnedListingInputSchema>;

export const marketplaceOwnedListingSchema = marketplaceListingMetadataSchema.extend({
  listingId: marketplaceListingIdSchema,
  slug: marketplaceSlugSchema,
  publisherName: z.string(),
  status: marketplaceListingStatusSchema,
  latestPublishedVersion: marketplaceVersionSchema.nullable(),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type MarketplaceOwnedListing = z.infer<typeof marketplaceOwnedListingSchema>;

export const marketplaceOwnedVersionSchema = z.object({
  version: marketplaceVersionSchema,
  status: marketplaceVersionStatusSchema,
  createdAt: z.string(),
  publishedAt: z.string().nullable(),
});

export type MarketplaceOwnedVersion = z.infer<typeof marketplaceOwnedVersionSchema>;

export const marketplaceOwnedListingDetailSchema = z.object({
  listing: marketplaceOwnedListingSchema,
  versions: z.array(marketplaceOwnedVersionSchema),
  nextVersionCursor: z.string().optional(),
  hasNextVersionPage: z.boolean(),
});

export type MarketplaceOwnedListingDetail = z.infer<typeof marketplaceOwnedListingDetailSchema>;

export const marketplaceListingPageSchema = z.object({
  listings: z.array(marketplacePublicListingSchema),
  nextCursor: z.string().optional(),
  hasNextPage: z.boolean(),
});

export type MarketplaceListingPage = z.infer<typeof marketplaceListingPageSchema>;

export const marketplaceOwnedListingPageSchema = z.object({
  listings: z.array(marketplaceOwnedListingSchema),
  nextCursor: z.string().optional(),
  hasNextPage: z.boolean(),
});

export type MarketplaceOwnedListingPage = z.infer<typeof marketplaceOwnedListingPageSchema>;

export const marketplaceDraftResultSchema = z.object({
  listingId: marketplaceListingIdSchema,
  slug: marketplaceSlugSchema,
  version: marketplaceVersionSchema,
  created: z.boolean(),
});

export type MarketplaceDraftResult = z.infer<typeof marketplaceDraftResultSchema>;

export const marketplaceListingUpdateResultSchema = marketplaceListingMetadataSchema.extend({
  listingId: marketplaceListingIdSchema,
  slug: marketplaceSlugSchema,
});

export type MarketplaceListingUpdateResult = z.infer<typeof marketplaceListingUpdateResultSchema>;

export const marketplacePublishVersionResultSchema = z.object({
  listingId: marketplaceListingIdSchema,
  slug: marketplaceSlugSchema,
  version: marketplaceVersionSchema,
  published: z.boolean(),
});

export type MarketplacePublishVersionResult = z.infer<typeof marketplacePublishVersionResultSchema>;

export const marketplaceArchiveResultSchema = z.object({
  listingId: marketplaceListingIdSchema,
  slug: marketplaceSlugSchema,
  archived: z.boolean(),
});

export type MarketplaceArchiveResult = z.infer<typeof marketplaceArchiveResultSchema>;

export const MARKETPLACE_OPERATION_ERROR_CODES = [
  "MARKETPLACE_OWNER_CONFLICT",
  "MARKETPLACE_LISTING_CONFLICT",
  "MARKETPLACE_LISTING_ARCHIVED",
  "MARKETPLACE_LISTING_NOT_FOUND",
  "MARKETPLACE_VERSION_NOT_FOUND",
  "MARKETPLACE_VERSION_TRANSITION_INVALID",
  "MARKETPLACE_PUBLICATION_CONFLICT",
] as const;

export type MarketplaceOperationErrorCode = (typeof MARKETPLACE_OPERATION_ERROR_CODES)[number];

export type MarketplaceOperationResult<TResult> =
  | { ok: true; value: TResult }
  | {
      ok: false;
      error: {
        code: MarketplaceOperationErrorCode;
        message: string;
      };
    };
