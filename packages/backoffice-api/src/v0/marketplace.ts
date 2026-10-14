import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";
import {
  backofficeOrganizationScopeSchema,
  backofficeProjectScopeSchema,
  backofficeUserScopeSchema,
} from "./shared/scope";

export const marketplaceTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "Tags use lowercase words separated by hyphens.");

export const marketplaceOwnerIdSchema = z.string().trim().min(1).max(191);

/** Scoped package names resolve to stable organization ownership, not a user or project owner. */
export const marketplaceOrganizationOwnerScopeSchema = z.strictObject({
  kind: z.literal("org"),
  orgId: marketplaceOwnerIdSchema,
});

export const marketplaceOwnerScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("system") }),
  marketplaceOrganizationOwnerScopeSchema,
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

/** System hosts the public Marketplace; each organization has its own members-only Marketplace. */
export const marketplaceScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("system") }),
  backofficeOrganizationScopeSchema,
]);

export type MarketplaceScope = z.infer<typeof marketplaceScopeSchema>;

/** Organization visibility publishes into the owning organization's Marketplace. */
export const marketplaceVisibilitySchema = z.enum(["public", "organization"]);

export type MarketplaceVisibility = z.infer<typeof marketplaceVisibilitySchema>;

export const marketplaceListingContentSchema = z.object({
  name: z.string().trim().min(3).max(120),
  summary: z.string().trim().min(10).max(240),
  description: z.string().trim().min(20).max(10_000),
  tags: z.array(marketplaceTagSchema).max(12).default([]),
});

export type MarketplaceListingContent = z.infer<typeof marketplaceListingContentSchema>;

export const MARKETPLACE_RELEASE_IDENTIFIER = String.raw`(?:0|[1-9]\d*)`;

export const MARKETPLACE_PRERELEASE_IDENTIFIER = String.raw`(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;

/** Each destination workspace has one root lock file, independent of installation folders. */
export const MARKETPLACE_LOCK_PATH = "/workspace/marketplace-lock.json";

export const MARKETPLACE_CATEGORIES = [
  "communication",
  "developer-tools",
  "operations",
  "productivity",
  "reporting",
] as const;

export const marketplaceSlugSchema = z
  .string()
  .trim()
  .min(3)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "Use lowercase words separated by hyphens.")
  .meta({ examples: ["telegram-test-command"] });

export const marketplacePackageOwnerSchema = marketplaceOwnerSchema.extend({
  scope: marketplaceOrganizationOwnerScopeSchema,
});

export const marketplaceCategorySchema = z.enum(MARKETPLACE_CATEGORIES);

export const marketplaceListingMetadataSchema = marketplaceListingContentSchema.extend({
  category: marketplaceCategorySchema,
});

export type MarketplaceListingMetadata = z.infer<typeof marketplaceListingMetadataSchema>;

export const marketplaceIngestionTargetScopeSchema = z.discriminatedUnion("kind", [
  backofficeOrganizationScopeSchema,
  backofficeProjectScopeSchema,
  backofficeUserScopeSchema,
]);

export type MarketplaceCategory = z.infer<typeof marketplaceCategorySchema>;

/** The workspace lock reserves its file path, including attempts to use it as a directory. */
export function isMarketplaceLockPath(path: string): boolean {
  return path === MARKETPLACE_LOCK_PATH || path.startsWith(`${MARKETPLACE_LOCK_PATH}/`);
}

export const MARKETPLACE_VERSION_PATTERN = new RegExp(
  String.raw`^${MARKETPLACE_RELEASE_IDENTIFIER}\.${MARKETPLACE_RELEASE_IDENTIFIER}\.${MARKETPLACE_RELEASE_IDENTIFIER}(?:-${MARKETPLACE_PRERELEASE_IDENTIFIER}(?:\.${MARKETPLACE_PRERELEASE_IDENTIFIER})*)?$`,
  "u",
);

export const MARKETPLACE_MAX_PAGE_SIZE = 60;

export const MARKETPLACE_DEFAULT_PAGE_SIZE = 18;

/** Each Marketplace curates a small featured set, so one bounded read loads every entry. */
export const MARKETPLACE_FEATURED_LIMIT = 24;

export const MARKETPLACE_DATABASE_ID_MAX_LENGTH = 128;

export const marketplaceVersionSchema = z
  .string()
  .trim()
  .max(40)
  .regex(MARKETPLACE_VERSION_PATTERN, "Use a semantic version such as 1.0.0.")
  .meta({ examples: ["1.0.0", "2.1.0-beta.1"] });

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

export const packageIdentitySchema = z.strictObject({
  name: z.string(),
  listingId: marketplaceListingIdSchema,
  version: marketplaceVersionSchema,
  snapshotId: z.string(),
  owner: marketplacePackageOwnerSchema,
  marketplace: marketplaceScopeSchema,
  files: z.array(
    z.strictObject({ relativePath: z.string(), sizeBytes: z.number(), checksum: z.string() }),
  ),
  sizeBytes: z.number(),
});

export const marketplaceVersionSchemaPublic = z.object({
  version: marketplaceVersionSchema,
  publishedAt: z.string(),
});

export type MarketplaceVersion = z.infer<typeof marketplaceVersionSchemaPublic>;

export const marketplaceVersionPageFields = {
  versionPageSize: z
    .number()
    .int()
    .min(1)
    .max(MARKETPLACE_MAX_PAGE_SIZE)
    .default(MARKETPLACE_DEFAULT_PAGE_SIZE),
  versionCursor: z.string().trim().min(1).optional(),
};

export const marketplacePublicListingSchema = marketplaceListingMetadataSchema.extend({
  listingId: marketplaceListingIdSchema,
  slug: marketplaceSlugSchema,
  publisherName: z.string(),
  status: z.literal("published"),
  latestVersion: marketplaceVersionSchema,
  publishedAt: z.string(),
  updatedAt: z.string(),
  /** The listing has a feature entry whose window is open now. */
  featured: z.boolean(),
});

export type MarketplaceListing = z.infer<typeof marketplacePublicListingSchema>;

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

/** Installation paths are absolute directories within the destination workspace. */
export const marketplaceInstallationRootSchema = z
  .string()
  .trim()
  .transform((path) => path.replace(/\/+$/u, ""))
  // Declaration generation needs the transform's concrete output schema.
  .pipe(z.string())
  .refine(
    (path) =>
      (path === "/workspace" || path.startsWith("/workspace/")) &&
      !/[\\\p{Cc}]/u.test(path) &&
      path
        .slice(1)
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "Choose an absolute install path under /workspace without '.' or '..' segments.",
  )
  .refine(
    (path) => !isMarketplaceLockPath(path),
    "The workspace Marketplace lock file cannot be used as an install folder.",
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

/** Installation names the Marketplace holding the listing; listing ids repeat across Marketplaces. */
export const marketplaceIngestionRequestInputSchema = z.object({
  marketplace: marketplaceScopeSchema,
  targetScope: marketplaceIngestionTargetScopeSchema,
  installationRoot: marketplaceInstallationRootSchema,
  listingId: marketplaceListingIdSchema,
  version: marketplaceVersionSchema.optional(),
});

export type MarketplaceIngestionRequestInput = z.infer<
  typeof marketplaceIngestionRequestInputSchema
>;

/** Installation reports the existing workflow result and its organization coordinator. */
export const packagesInstallResultSchema = marketplaceIngestionRestartResultSchema.extend({
  installationRoot: marketplaceInstallationRootSchema,
  workflowScope: z.object({ kind: z.literal("org"), orgId: z.string().min(1) }),
});

/** Read and install tools address the public Marketplace unless organization visibility is requested. */
const marketplaceReadVisibilityField = {
  visibility: marketplaceVisibilitySchema.default("public"),
};

/** Package installation takes its destination scope and organization Marketplace from the runtime, not caller input. */
export const packagesInstallInputSchema = marketplaceIngestionRequestInputSchema
  .omit({ marketplace: true, targetScope: true })
  .extend(marketplaceReadVisibilityField)
  .strict();

/** Registry search returns compact metadata and a cursor for the next candidate page. */
export const marketplaceSearchResultSchema = z.object({
  listings: z.array(
    marketplacePublicListingSchema.pick({
      listingId: true,
      name: true,
      summary: true,
      publisherName: true,
      category: true,
      tags: true,
      latestVersion: true,
      featured: true,
    }),
  ),
  nextCursor: z.string().nullable(),
  hasNextPage: z.boolean(),
});

/** Search cursors advance through registry candidates, including pages without matches. */
export const marketplaceSearchInputSchema = marketplaceListingPageInputSchema.extend({
  query: z.string().trim().min(1).max(240),
  ...marketplaceReadVisibilityField,
});

export const marketplacePublishedListingInputSchema = z.object({
  listingId: marketplaceListingIdSchema,
  ...marketplaceVersionPageFields,
});

export type MarketplacePublishedListingInput = z.input<
  typeof marketplacePublishedListingInputSchema
>;

export const marketplaceViewInputSchema = marketplacePublishedListingInputSchema.extend(
  marketplaceReadVisibilityField,
);

/** A dry run writes nothing; accepted packages return their durable System workflow identity. */
export const marketplacePublishResultSchema = z.discriminatedUnion("state", [
  packageIdentitySchema.extend({ state: z.literal("preview") }),
  packageIdentitySchema.extend({
    state: z.enum(["requested", "published"]),
    workflowInstanceId: z.string(),
    workflowScope: z.strictObject({ kind: z.literal("system") }),
  }),
]);

export type MarketplacePublishResult = z.output<typeof marketplacePublishResultSchema>;

/** Publishing switches are enforced against the original caller, never the coordinator. */
export const marketplacePublishInputSchema = z.strictObject({
  packageRoot: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .refine(
      (path) =>
        path.startsWith("/") &&
        path !== "/" &&
        !/[\\\p{Cc}]/u.test(path) &&
        path
          .replace(/\/$/u, "")
          .slice(1)
          .split("/")
          .every((segment) => segment && segment !== "." && segment !== ".."),
      "Marketplace package root must be an absolute directory path without traversal.",
    )
    .transform((path) => path.replace(/\/$/u, ""))
    .pipe(z.string()),
  visibility: marketplaceVisibilitySchema,
  dryRun: z.boolean().default(false),
  skipAuthorCheck: z.boolean().default(false),
  skipVersionCheck: z.boolean().default(false),
});

/** The workspace lock records one successful release per listing and installation folder. */
export const marketplaceLockSchema = z
  .strictObject({
    entries: z.array(
      z.strictObject({
        // Locks written before organization Marketplaces existed only installed public listings.
        marketplace: marketplaceScopeSchema.default({ kind: "system" }),
        listingId: marketplaceListingIdSchema,
        version: marketplaceVersionSchema,
        installationRoot: marketplaceInstallationRootSchema,
      }),
    ),
  })
  .refine(
    (lock) =>
      new Set(
        lock.entries.map((entry) => JSON.stringify([entry.listingId, entry.installationRoot])),
      ).size === lock.entries.length,
    "Marketplace lock entries must have unique listing and installation folder pairs.",
  );

export const marketplaceListingDetailSchema = z.object({
  listing: marketplacePublicListingSchema,
  versions: z.array(marketplaceVersionSchemaPublic),
  nextVersionCursor: z.string().optional(),
  hasNextVersionPage: z.boolean(),
});

export type MarketplaceListingDetail = z.infer<typeof marketplaceListingDetailSchema>;

/** Hidden entries belong to listings that are no longer published. */
export const marketplaceFeatureStateSchema = z.enum(["active", "scheduled", "expired", "hidden"]);

export type MarketplaceFeatureState = z.infer<typeof marketplaceFeatureStateSchema>;

/** Curators see every entry with its state; browsers only see active entries. */
export const marketplaceFeatureEntrySchema = z.object({
  listingId: marketplaceListingIdSchema,
  name: z.string(),
  state: marketplaceFeatureStateSchema,
  priority: z.number().int(),
  note: z.string().nullable(),
  startsAt: z.string(),
  until: z.string().nullable(),
  featuredBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type MarketplaceFeatureEntry = z.infer<typeof marketplaceFeatureEntrySchema>;

/** Featuring an already featured listing replaces its window, priority, and note. */
export const marketplaceFeaturedResultSchema = z.object({
  entries: z.array(marketplaceFeatureEntrySchema),
  limit: z.number().int(),
});

export type MarketplaceFeaturedResult = z.infer<typeof marketplaceFeaturedResultSchema>;

const MARKETPLACE_CURATION_AUTHORITY =
  "In System scope this curates the public Marketplace and requires a System administrator; in organization scope it curates that organization's Marketplace and requires an organization owner or admin.";

export const marketplaceOperations = {
  "marketplace.search": {
    description:
      "Search published package metadata in the public Marketplace, or in the current organization's Marketplace with organization visibility. Follow nextCursor while hasNextPage is true, even when a candidate page has no matches.",
    permissions: [BACKOFFICE_PERMISSION.marketplace.read],
    input: marketplaceSearchInputSchema,
    output: marketplaceSearchResultSchema,
  },
  "marketplace.view": {
    description:
      "Inspect published package metadata and cursor-paginated releases in the public Marketplace, or in the current organization's Marketplace with organization visibility.",
    permissions: [BACKOFFICE_PERMISSION.marketplace.read],
    input: marketplaceViewInputSchema,
    output: marketplaceListingDetailSchema,
  },
  "marketplace.publish": {
    description:
      "Publish a captured package from a root manifest.json containing name @<organization-slug>/<package-slug>. Public visibility publishes to the public Marketplace; organization visibility publishes to the owning organization's members-only Marketplace. Versions are immutable by default; System may explicitly replace them. Dry runs write nothing. Author and version overrides require System context.",
    permissions: [BACKOFFICE_PERMISSION.marketplace.publish],
    input: marketplacePublishInputSchema,
    output: marketplacePublishResultSchema,
  },
  // Curation authority depends on the scope, so the runtime checks it beyond the read permission.
  "marketplace.featured": {
    description: `List every feature entry with its state: active, scheduled, expired, or hidden (the listing is no longer published). ${MARKETPLACE_CURATION_AUTHORITY}`,
    permissions: [BACKOFFICE_PERMISSION.marketplace.read],
    input: z.strictObject({}),
    output: marketplaceFeaturedResultSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;

export const packagesOperations = {
  "packages.install": {
    description:
      "Start the existing Marketplace installation workflow in the current workspace at a required folder under /workspace. Installs from the public Marketplace, or from the installing organization's Marketplace with organization visibility. Installation is asynchronous and never overwrites differing files. Omit version to use the existing latest-release resolution.",
    permissions: [BACKOFFICE_PERMISSION.packages.install],
    input: packagesInstallInputSchema,
    output: packagesInstallResultSchema,
  },
  "packages.ls": {
    description:
      "List successful package installations recorded in /workspace/marketplace-lock.json for the current workspace. A missing lock is empty; malformed locks fail without being modified.",
    permissions: [BACKOFFICE_PERMISSION.packages.read],
    input: z.strictObject({}),
    output: marketplaceLockSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
