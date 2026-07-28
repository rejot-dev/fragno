import { z } from "zod";

import { marketplaceListingId, marketplaceVersionId } from "./owner";

export const MARKETPLACE_DEFAULT_PAGE_SIZE = 18;
export const MARKETPLACE_MAX_PAGE_SIZE = 60;
const MARKETPLACE_DATABASE_ID_MAX_LENGTH = 128;

export const marketplaceSlugSchema = z
  .string()
  .trim()
  .min(3)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "Use lowercase words separated by hyphens.")
  .meta({ examples: ["telegram-test-command"] });

export const marketplaceVersionSchema = z
  .string()
  .trim()
  .max(40)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, "Use a semantic version such as 1.0.0.")
  .meta({ examples: ["1.0.0", "2.1.0-beta.1"] });

export const marketplaceArtifactDirectorySchema = z
  .string()
  .trim()
  .min(1)
  .max(191)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "Use a relative artifact directory without empty, '.' or '..' path segments.",
  )
  .meta({ examples: ["1.0.0"] });

export const marketplaceListingIdSchema = z
  .string()
  .trim()
  .min(5)
  .max(MARKETPLACE_DATABASE_ID_MAX_LENGTH)
  .regex(
    /^(?:system|org:[^#]+|user:[^#]+|project:[^#:]+:[^#]+)#[a-z0-9]+(?:-[a-z0-9]+)*$/u,
    "Use an owner-qualified marketplace listing id.",
  )
  .meta({
    examples: ["system#telegram-test-command", "org:org-123#deployment-notifier"],
  });

export const MARKETPLACE_CATEGORIES = [
  "communication",
  "developer-tools",
  "operations",
  "productivity",
  "reporting",
] as const;

export const marketplaceCategorySchema = z.enum(MARKETPLACE_CATEGORIES);
export type MarketplaceCategory = z.infer<typeof marketplaceCategorySchema>;

const marketplaceTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "Tags use lowercase words separated by hyphens.");

export const marketplaceListingContentSchema = z.object({
  name: z.string().trim().min(3).max(120),
  summary: z.string().trim().min(10).max(240),
  description: z.string().trim().min(20).max(10_000),
  tags: z.array(marketplaceTagSchema).max(12).default([]),
});

export type MarketplaceListingContent = z.infer<typeof marketplaceListingContentSchema>;

export const marketplaceListingMetadataSchema = marketplaceListingContentSchema.extend({
  category: marketplaceCategorySchema,
});

export type MarketplaceListingMetadata = z.infer<typeof marketplaceListingMetadataSchema>;

const marketplaceOwnerIdSchema = z.string().trim().min(1).max(191);

export const marketplaceOwnerScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("system") }),
  z.object({ kind: z.literal("org"), orgId: marketplaceOwnerIdSchema }),
  z.object({ kind: z.literal("user"), userId: marketplaceOwnerIdSchema }),
  z.object({
    kind: z.literal("project"),
    orgId: marketplaceOwnerIdSchema,
    projectId: marketplaceOwnerIdSchema,
  }),
]);

export type MarketplaceOwnerScope = z.infer<typeof marketplaceOwnerScopeSchema>;

export const marketplaceOwnerSchema = z.object({
  scope: marketplaceOwnerScopeSchema,
  publisherName: z.string().trim().min(1).max(191),
});

export type MarketplaceOwner = z.infer<typeof marketplaceOwnerSchema>;

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
    artifactDirectory: marketplaceArtifactDirectorySchema.optional(),
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

export const marketplaceArtifactManifestSchema = z.object({
  listingId: marketplaceListingIdSchema,
  slug: marketplaceSlugSchema,
  listingStatus: marketplaceListingStatusSchema,
  uploadName: z.string(),
  versions: z.array(
    z.object({
      version: marketplaceVersionSchema,
      directory: marketplaceArtifactDirectorySchema,
    }),
  ),
});

export type MarketplaceArtifactManifest = z.infer<typeof marketplaceArtifactManifestSchema>;

const marketplaceStaticPublicationIdentitySchema = z.object({
  listingId: marketplaceListingIdSchema,
  slug: marketplaceSlugSchema,
  version: marketplaceVersionSchema,
  workflowInstanceId: z.string(),
});

export const marketplaceStaticPublicationEntryResultSchema = z.discriminatedUnion("state", [
  marketplaceStaticPublicationIdentitySchema.extend({
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

export const marketplaceListingPageInputSchema = z.object({
  category: marketplaceCategorySchema.optional(),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(MARKETPLACE_MAX_PAGE_SIZE)
    .default(MARKETPLACE_DEFAULT_PAGE_SIZE),
  cursor: z.string().trim().min(1).optional(),
});

export type MarketplaceListingPageInput = z.input<typeof marketplaceListingPageInputSchema>;

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

const marketplaceVersionPageFields = {
  versionPageSize: z
    .number()
    .int()
    .min(1)
    .max(MARKETPLACE_MAX_PAGE_SIZE)
    .default(MARKETPLACE_DEFAULT_PAGE_SIZE),
  versionCursor: z.string().trim().min(1).optional(),
};

export const marketplacePublishedListingInputSchema = z.object({
  listingId: marketplaceListingIdSchema,
  ...marketplaceVersionPageFields,
});

export type MarketplacePublishedListingInput = z.input<
  typeof marketplacePublishedListingInputSchema
>;

export const marketplaceOwnedListingInputSchema = z.object({
  listingId: marketplaceListingIdSchema,
  ownerScope: marketplaceOwnerScopeSchema,
  ...marketplaceVersionPageFields,
});

export type MarketplaceOwnedListingInput = z.input<typeof marketplaceOwnedListingInputSchema>;

export const marketplacePublicListingSchema = marketplaceListingMetadataSchema.extend({
  listingId: marketplaceListingIdSchema,
  slug: marketplaceSlugSchema,
  publisherName: z.string(),
  status: z.literal("published"),
  latestVersion: marketplaceVersionSchema,
  publishedAt: z.string(),
  updatedAt: z.string(),
});

export type MarketplaceListing = z.infer<typeof marketplacePublicListingSchema>;

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

export const marketplaceVersionSchemaPublic = z.object({
  version: marketplaceVersionSchema,
  publishedAt: z.string(),
});

export type MarketplaceVersion = z.infer<typeof marketplaceVersionSchemaPublic>;

export const marketplaceOwnedVersionSchema = z.object({
  version: marketplaceVersionSchema,
  status: marketplaceVersionStatusSchema,
  createdAt: z.string(),
  publishedAt: z.string().nullable(),
});

export type MarketplaceOwnedVersion = z.infer<typeof marketplaceOwnedVersionSchema>;

export const marketplaceListingDetailSchema = z.object({
  listing: marketplacePublicListingSchema,
  versions: z.array(marketplaceVersionSchemaPublic),
  nextVersionCursor: z.string().optional(),
  hasNextVersionPage: z.boolean(),
});

export type MarketplaceListingDetail = z.infer<typeof marketplaceListingDetailSchema>;

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
