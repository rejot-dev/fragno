import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { automationRouteCreateInputSchema } from "./automation";
import { automationEventDefinitionCreateInputSchema } from "./events";
import { piAgentDefinitionCreateSchema } from "./pi";
import { BACKOFFICE_PERMISSION, backofficePermissionRequirementSchema } from "./shared/permissions";
import {
  backofficeOrganizationScopeSchema,
  backofficeProjectScopeSchema,
  backofficeUserScopeSchema,
} from "./shared/scope";

export const marketplaceTagSchema = z.lazy(() =>
  z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "Tags use lowercase words separated by hyphens."),
);

export const marketplaceOwnerIdSchema = z.lazy(() => z.string().trim().min(1).max(191));

/** Scoped package names resolve to stable organization ownership, not a user or project owner. */
export const marketplaceOrganizationOwnerScopeSchema = z.lazy(() =>
  z.strictObject({
    kind: z.literal("org"),
    orgId: marketplaceOwnerIdSchema,
  }),
);

const marketplaceUserOwnerScopeSchema = z.lazy(() =>
  z.object({
    kind: z.literal("user"),
    userId: marketplaceOwnerIdSchema,
  }),
);
const marketplaceAppOwnerScopeSchema = z.lazy(() =>
  z.object({
    kind: z.literal("app"),
    owner: z.discriminatedUnion("kind", [
      marketplaceOrganizationOwnerScopeSchema,
      marketplaceUserOwnerScopeSchema,
    ]),
    appId: marketplaceOwnerIdSchema,
  }),
);

export const marketplaceOwnerScopeSchema = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("system") }),
    marketplaceOrganizationOwnerScopeSchema,
    marketplaceUserOwnerScopeSchema,
    marketplaceAppOwnerScopeSchema,
    z.object({
      kind: z.literal("project"),
      owner: z.discriminatedUnion("kind", [
        marketplaceOrganizationOwnerScopeSchema,
        marketplaceUserOwnerScopeSchema,
        marketplaceAppOwnerScopeSchema,
      ]),
      projectId: marketplaceOwnerIdSchema,
    }),
  ]),
);

export type MarketplaceOwnerScope = z.infer<typeof marketplaceOwnerScopeSchema>;

export const marketplaceOwnerSchema = z.lazy(() =>
  z.object({
    scope: marketplaceOwnerScopeSchema,
    publisherName: z.string().trim().min(1).max(191),
  }),
);

export type MarketplaceOwner = z.infer<typeof marketplaceOwnerSchema>;

/** System hosts the public Marketplace; each organization has its own members-only Marketplace. */
export const marketplaceScopeSchema = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("system") }),
    backofficeOrganizationScopeSchema,
  ]),
);

export type MarketplaceScope = z.infer<typeof marketplaceScopeSchema>;

/** Organization visibility publishes into the owning organization's Marketplace. */
export const marketplaceVisibilitySchema = z.lazy(() => z.enum(["public", "organization"]));

export type MarketplaceVisibility = z.infer<typeof marketplaceVisibilitySchema>;

export const marketplaceListingContentSchema = z.lazy(() =>
  z.object({
    name: z.string().trim().min(3).max(120),
    summary: z.string().trim().min(10).max(240),
    description: z.string().trim().min(20).max(10_000),
    tags: z.array(marketplaceTagSchema).max(12).default([]),
  }),
);

export type MarketplaceListingContent = z.infer<typeof marketplaceListingContentSchema>;

export const MARKETPLACE_RELEASE_IDENTIFIER = String.raw`(?:0|[1-9]\d*)`;

export const MARKETPLACE_PRERELEASE_IDENTIFIER = String.raw`(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;

/**
 * Installations used to be recorded in this workspace file. Backoffice now keeps installation records
 * itself and only reads the file to import them with `packages.importLegacy`, which deletes it.
 */
export const MARKETPLACE_LOCK_PATH = "/workspace/marketplace-lock.json";

export const MARKETPLACE_CATEGORIES = [
  "communication",
  "developer-tools",
  "operations",
  "productivity",
  "reporting",
] as const;

export const marketplaceSlugSchema = z
  .lazy(() =>
    z
      .string()
      .trim()
      .min(3)
      .max(80)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "Use lowercase words separated by hyphens."),
  )
  .meta({ examples: ["telegram-test-command"] });

export const marketplacePackageOwnerSchema = z.lazy(() =>
  marketplaceOwnerSchema._zod.innerType.extend({
    scope: marketplaceOrganizationOwnerScopeSchema,
  }),
);

export const marketplaceCategorySchema = z.lazy(() => z.enum(MARKETPLACE_CATEGORIES));

export const marketplaceListingMetadataSchema = z.lazy(() =>
  marketplaceListingContentSchema._zod.innerType.extend({
    category: marketplaceCategorySchema,
  }),
);

export type MarketplaceListingMetadata = z.infer<typeof marketplaceListingMetadataSchema>;

export const marketplaceIngestionTargetScopeSchema = z.lazy(() =>
  z.discriminatedUnion("kind", [
    backofficeOrganizationScopeSchema,
    backofficeProjectScopeSchema,
    backofficeUserScopeSchema,
  ]),
);
export type MarketplaceIngestionTargetScope = z.infer<typeof marketplaceIngestionTargetScopeSchema>;

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
  .lazy(() =>
    z
      .string()
      .trim()
      .max(40)
      .regex(MARKETPLACE_VERSION_PATTERN, "Use a semantic version such as 1.0.0."),
  )
  .meta({ examples: ["1.0.0", "2.1.0-beta.1"] });

export const marketplaceListingIdSchema = z
  .lazy(() =>
    z
      .string()
      .trim()
      .min(5)
      .max(MARKETPLACE_DATABASE_ID_MAX_LENGTH)
      .regex(
        /^(?:system|org:[^#]+|user:[^#]+|project:[^#:]+:[^#]+)#[a-z0-9]+(?:-[a-z0-9]+)*$/u,
        "Use an owner-qualified marketplace listing id.",
      ),
  )
  .meta({
    examples: ["system#telegram-test-command", "org:org-123#deployment-notifier"],
  });

export const packageIdentitySchema = z.lazy(() =>
  z.strictObject({
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
  }),
);

export const marketplaceVersionSchemaPublic = z.lazy(() =>
  z.object({
    version: marketplaceVersionSchema,
    publishedAt: z.string(),
  }),
);

export type MarketplaceVersion = z.infer<typeof marketplaceVersionSchemaPublic>;

export const marketplaceVersionPageFields = {
  versionPageSize: z.lazy(() =>
    z.number().int().min(1).max(MARKETPLACE_MAX_PAGE_SIZE).default(MARKETPLACE_DEFAULT_PAGE_SIZE),
  ),
  versionCursor: z.lazy(() => z.string().trim().min(1).optional()),
};

export const marketplacePublicListingSchema = z.lazy(() =>
  marketplaceListingMetadataSchema._zod.innerType.extend({
    listingId: marketplaceListingIdSchema,
    slug: marketplaceSlugSchema,
    publisherName: z.string(),
    status: z.literal("published"),
    latestVersion: marketplaceVersionSchema,
    publishedAt: z.string(),
    updatedAt: z.string(),
    /** The listing has a feature entry whose window is open now. */
    featured: z.boolean(),
  }),
);

export type MarketplaceListing = z.infer<typeof marketplacePublicListingSchema>;

export const marketplaceListingPageInputSchema = z.lazy(() =>
  z.object({
    category: marketplaceCategorySchema.optional(),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(MARKETPLACE_MAX_PAGE_SIZE)
      .default(MARKETPLACE_DEFAULT_PAGE_SIZE),
    cursor: z.string().trim().min(1).optional(),
  }),
);

export type MarketplaceListingPageInput = z.input<typeof marketplaceListingPageInputSchema>;

/** Installation paths are absolute directories within the destination workspace. */
export const marketplaceInstallationRootSchema = z.lazy(() =>
  z
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
    ),
);

/** Installation callers share the existing workflow restart result contract. */
export const marketplaceIngestionRestartResultSchema = z.lazy(() =>
  z.object({
    listingId: marketplaceListingIdSchema,
    version: marketplaceVersionSchema,
    workflowInstanceId: z.string().min(1),
    action: z.enum(["created", "restarted", "unchanged"]),
    workflowStatus: z.enum(["active", "paused", "errored", "terminated", "complete", "waiting"]),
  }),
);

export type MarketplaceIngestionRestartResult = z.infer<
  typeof marketplaceIngestionRestartResultSchema
>;

/** The permissions a package's routes and install workflow may use, approved by its installer. */
export const packagePermissionsSchema = z.lazy(() =>
  z
    .array(backofficePermissionRequirementSchema)
    .refine(
      (permissions) =>
        new Set(permissions.map(({ namespace, permission }) => `${namespace}.${permission}`))
          .size === permissions.length,
      "Package permissions must be unique.",
    ),
);

/**
 * What installing a release sets up beyond copying its files: the permissions its routes and install
 * workflow use, and the routes, event definitions, and agents Backoffice keeps in sync for each
 * installation. A route's `start_workflow` names a file in the package; the installation resolves it
 * to the installed copy.
 */
export const marketplacePackageDeclarationSchema = z.lazy(() =>
  z.strictObject({
    permissions: packagePermissionsSchema.default([]),
    routes: z
      .array(automationRouteCreateInputSchema)
      .default([])
      .refine(
        (routes) => new Set(routes.map((route) => route.id)).size === routes.length,
        "Declared route ids must be unique.",
      ),
    eventDefinitions: z
      .array(automationEventDefinitionCreateInputSchema)
      .default([])
      .refine(
        (definitions) =>
          new Set(definitions.map(({ source, eventType }) => JSON.stringify([source, eventType])))
            .size === definitions.length,
        "Declared event definitions must each have their own source and event type.",
      ),
    agents: z
      .array(piAgentDefinitionCreateSchema._zod.innerType.strict())
      .default([])
      .refine(
        (agents) => new Set(agents.map((agent) => agent.agentName)).size === agents.length,
        "Declared agent names must be unique.",
      ),
  }),
);

export type MarketplacePackageDeclaration = z.infer<typeof marketplacePackageDeclarationSchema>;

/** Installation names the Marketplace holding the listing; listing ids repeat across Marketplaces. */
export const marketplaceIngestionRequestInputSchema = z.lazy(() =>
  z.object({
    marketplace: marketplaceScopeSchema,
    targetScope: marketplaceIngestionTargetScopeSchema,
    installationRoot: marketplaceInstallationRootSchema,
    listingId: marketplaceListingIdSchema,
    version: marketplaceVersionSchema.optional(),
    /** Must equal the release's declared permissions; the installer must hold each of them. */
    permissions: packagePermissionsSchema.default([]),
  }),
);

export type MarketplaceIngestionRequestInput = z.input<
  typeof marketplaceIngestionRequestInputSchema
>;

/** Installation reports the existing workflow result and its organization coordinator. */
export const packagesInstallResultSchema = z.lazy(() =>
  marketplaceIngestionRestartResultSchema._zod.innerType.extend({
    installationRoot: marketplaceInstallationRootSchema,
    workflowScope: backofficeOrganizationScopeSchema,
  }),
);

/** Read and install tools address the public Marketplace unless organization visibility is requested. */
const marketplaceReadVisibilityField = {
  visibility: z.lazy(() => marketplaceVisibilitySchema.default("public")),
};

/** Package installation takes its destination scope and organization Marketplace from the runtime, not caller input. */
export const packagesInstallInputSchema = z.lazy(() =>
  marketplaceIngestionRequestInputSchema._zod.innerType
    .omit({ marketplace: true, targetScope: true })
    .extend(marketplaceReadVisibilityField)
    .strict(),
);

/** Registry search returns compact metadata and a cursor for the next candidate page. */
export const marketplaceSearchResultSchema = z.lazy(() =>
  z.object({
    listings: z.array(
      marketplacePublicListingSchema._zod.innerType.pick({
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
  }),
);

/** Search cursors advance through registry candidates, including pages without matches. */
export const marketplaceSearchInputSchema = z.lazy(() =>
  marketplaceListingPageInputSchema._zod.innerType.extend({
    query: z.string().trim().min(1).max(240),
    ...marketplaceReadVisibilityField,
  }),
);

export const marketplacePublishedListingInputSchema = z.lazy(() =>
  z.object({
    listingId: marketplaceListingIdSchema,
    ...marketplaceVersionPageFields,
  }),
);

export type MarketplacePublishedListingInput = z.input<
  typeof marketplacePublishedListingInputSchema
>;

export const marketplaceViewInputSchema = z.lazy(() =>
  marketplacePublishedListingInputSchema._zod.innerType.extend({
    ...marketplaceReadVisibilityField,
    /** The release whose declaration to read; the latest when omitted, as installing does. */
    version: marketplaceVersionSchema.optional(),
  }),
);

/** A dry run writes nothing; accepted packages return their durable System workflow identity. */
export const marketplacePublishResultSchema = z.lazy(() =>
  z.discriminatedUnion("state", [
    packageIdentitySchema._zod.innerType.extend({ state: z.literal("preview") }),
    packageIdentitySchema._zod.innerType.extend({
      state: z.enum(["requested", "published"]),
      workflowInstanceId: z.string(),
      workflowScope: z.strictObject({ kind: z.literal("system") }),
    }),
  ]),
);

export type MarketplacePublishResult = z.output<typeof marketplacePublishResultSchema>;

/** Publishing switches are enforced against the original caller, never the coordinator. */
export const marketplacePublishInputSchema = z.lazy(() =>
  z.strictObject({
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
  }),
);

/** The legacy workspace lock recorded one successful release per listing and installation folder. */
export const marketplaceLockSchema = z.lazy(() =>
  z
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
    ),
);

export const marketplaceListingDetailSchema = z.lazy(() =>
  z.object({
    listing: marketplacePublicListingSchema,
    versions: z.array(marketplaceVersionSchemaPublic),
    nextVersionCursor: z.string().optional(),
    hasNextVersionPage: z.boolean(),
  }),
);

export type MarketplaceListingDetail = z.infer<typeof marketplaceListingDetailSchema>;

/** A listing with one release's declaration, which an installer approves the permissions of. */
export const marketplaceViewResultSchema = z.lazy(() =>
  marketplaceListingDetailSchema._zod.innerType.extend({
    release: marketplacePackageDeclarationSchema._zod.innerType.extend({
      version: marketplaceVersionSchema,
    }),
  }),
);

export type MarketplaceViewResult = z.infer<typeof marketplaceViewResultSchema>;

/** Hidden entries belong to listings that are no longer published. */
export const marketplaceFeatureStateSchema = z.lazy(() =>
  z.enum(["active", "scheduled", "expired", "hidden"]),
);

export type MarketplaceFeatureState = z.infer<typeof marketplaceFeatureStateSchema>;

/** Curators see every entry with its state; browsers only see active entries. */
export const marketplaceFeatureEntrySchema = z.lazy(() =>
  z.object({
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
  }),
);

export type MarketplaceFeatureEntry = z.infer<typeof marketplaceFeatureEntrySchema>;

/** Featuring an already featured listing replaces its window, priority, and note. */
export const marketplaceFeaturedResultSchema = z.lazy(() =>
  z.object({
    entries: z.array(marketplaceFeatureEntrySchema),
    limit: z.number().int(),
  }),
);

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
      "Inspect published package metadata and cursor-paginated releases in the public Marketplace, or in the current organization's Marketplace with organization visibility. `release` is what installing one release (the latest unless version is given) sets up: the permissions to approve with packages.install, and the routes, event definitions, and agents it defines. Its routes' start_workflow paths are relative to the installation folder.",
    permissions: [BACKOFFICE_PERMISSION.marketplace.read],
    input: marketplaceViewInputSchema,
    output: marketplaceViewResultSchema,
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
    input: z.lazy(() => z.strictObject({})),
    output: marketplaceFeaturedResultSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;

/**
 * One installed package in a workspace. A workspace holds at most one installation of a listing,
 * because the routes a package declares have fixed ids. `settings` is what the package's install
 * workflow returned; packages without one have empty settings.
 */
export const packageInstallationSchema = z.lazy(() =>
  z.strictObject({
    marketplace: marketplaceScopeSchema,
    listingId: marketplaceListingIdSchema,
    version: marketplaceVersionSchema,
    installationRoot: marketplaceInstallationRootSchema,
    permissions: packagePermissionsSchema,
    settings: z.record(z.string(), z.unknown()),
  }),
);

export type PackageInstallation = z.infer<typeof packageInstallationSchema>;

const packageListingInputSchema = z.lazy(() =>
  z.strictObject({ listingId: marketplaceListingIdSchema }),
);

/** What uninstalling deleted besides the installation record. */
export const packageUninstallationSchema = z.lazy(() =>
  z.strictObject({
    installation: packageInstallationSchema,
    removedRouteIds: z.array(z.string()),
    removedEventDefinitions: z.array(z.strictObject({ source: z.string(), eventType: z.string() })),
    removedAgents: z.array(z.string()),
  }),
);

export type PackageUninstallation = z.infer<typeof packageUninstallationSchema>;

const packageLocationSchema = z.lazy(() =>
  z.strictObject({
    listingId: marketplaceListingIdSchema,
    installationRoot: marketplaceInstallationRootSchema,
  }),
);

export const packagesImportLegacyInputSchema = z.lazy(() =>
  z.strictObject({
    /** For a listing the lock records in several folders, the one folder to import. */
    keep: z.array(packageLocationSchema).default([]),
  }),
);

export type PackagesImportLegacyInput = z.input<typeof packagesImportLegacyInputSchema>;

/**
 * `alreadyInstalled` lists lock entries of listings that already have an installation, which
 * stays. `lock` is `absent` when there was nothing to import, `deleted` once every entry is
 * imported or already installed, and `kept` while conflicts remain.
 */
export const packagesImportLegacyResultSchema = z.lazy(() =>
  z.strictObject({
    imported: z.array(packageInstallationSchema),
    alreadyInstalled: z.array(packageLocationSchema),
    conflicts: z.array(
      z.strictObject({
        listingId: marketplaceListingIdSchema,
        installationRoots: z.array(marketplaceInstallationRootSchema),
      }),
    ),
    /** `changed`: the file changed while importing, so it stays for importing again. */
    lock: z.enum(["absent", "deleted", "kept", "changed"]),
  }),
);

export type PackagesImportLegacyResult = z.infer<typeof packagesImportLegacyResultSchema>;

const packageWorkflowStatusSchema = z.lazy(() =>
  z.enum(["active", "paused", "waiting", "complete", "errored", "terminated"]),
);

const packageWorkflowErrorSchema = z.lazy(() =>
  z.strictObject({ name: z.string(), message: z.string() }),
);

/**
 * A package's own install workflow, a saved workflow in the installation's coordinating
 * organization, where workflow.getInstance reads what it waits for and workflow.sendEvent answers.
 */
const packageInstallerStatusSchema = z.lazy(() =>
  z.strictObject({
    workflowInstanceId: z.string(),
    status: packageWorkflowStatusSchema,
  }),
);

/** Where one installation run stands; it records the installation once it completes. */
export const packageInstallStatusSchema = z.lazy(() =>
  z.discriminatedUnion("status", [
    z.strictObject({
      listingId: marketplaceListingIdSchema,
      version: marketplaceVersionSchema,
      installationRoot: marketplaceInstallationRootSchema,
      status: z.enum(["active", "paused", "waiting", "complete"]),
      installer: packageInstallerStatusSchema.nullable(),
    }),
    z.strictObject({
      listingId: marketplaceListingIdSchema,
      version: marketplaceVersionSchema,
      installationRoot: marketplaceInstallationRootSchema,
      status: z.enum(["errored", "terminated"]),
      error: packageWorkflowErrorSchema,
      installer: packageInstallerStatusSchema.nullable(),
    }),
  ]),
);

export type PackageInstallStatus = z.infer<typeof packageInstallStatusSchema>;

/** Names an installation run as packages.install returned it, with the organization running it. */
export const packagesStatusInputSchema = z.lazy(() =>
  z.strictObject({
    workflowInstanceId: z.string().trim().min(1),
    workflowScope: backofficeOrganizationScopeSchema,
  }),
);

export const packagesOperations = {
  "packages.install": {
    description:
      "Start the Marketplace installation workflow in the current workspace at a required folder under /workspace. Installs from the public Marketplace, or from the installing organization's Marketplace with organization visibility. Installation is asynchronous: follow workflowInstanceId with packages.status. Pass the release's declared permissions, which marketplace.view returns, to approve them; the install is refused unless they match exactly, and you must hold each one. A workspace holds one installation per listing: installing another version upgrades it in place, replacing and removing files that still match the installed version, and fails without changes if a file it would replace was edited. Installing the installed version again re-runs its install workflow, which is how its settings are changed. Omit version to use the latest release.",
    permissions: [BACKOFFICE_PERMISSION.packages.install],
    input: packagesInstallInputSchema,
    output: packagesInstallResultSchema,
  },
  "packages.status": {
    description:
      "Get where an installation started with packages.install stands, by the workflowInstanceId and workflowScope it returned, or null when this workspace has no such installation. A complete run has recorded the installation, which packages.get reads; a failed one says why. installer is the package's own install workflow, null for packages without one or until it starts. While it waits, such as for the package's settings, read the event types it waits for with workflow.getInstance and send them with workflow.sendEvent, both in the workflowScope organization.",
    permissions: [BACKOFFICE_PERMISSION.packages.read],
    input: packagesStatusInputSchema,
    output: z.lazy(() => packageInstallStatusSchema.nullable()),
  },
  "packages.ls": {
    description: "List the package installations in the current workspace.",
    permissions: [BACKOFFICE_PERMISSION.packages.read],
    input: z.lazy(() => z.strictObject({})),
    output: z.lazy(() => z.object({ installations: z.array(packageInstallationSchema) })),
  },
  "packages.get": {
    description:
      "Get one package installation in the current workspace, including its settings, or null when the listing is not installed. Package workflows read their settings this way.",
    permissions: [BACKOFFICE_PERMISSION.packages.read],
    input: packageListingInputSchema,
    output: z.lazy(() => packageInstallationSchema.nullable()),
  },
  "packages.uninstall": {
    description:
      "Uninstall a package from the current workspace: delete the agents, routes, and event definitions it manages and its installation record. Its files stay in its installation folder. Uninstalling a listing that is not installed changes nothing and returns null.",
    permissions: [BACKOFFICE_PERMISSION.packages.install],
    input: packageListingInputSchema,
    output: z.lazy(() => packageUninstallationSchema.nullable()),
  },
  "packages.importLegacy": {
    description: `Import the installations recorded in the legacy workspace file ${MARKETPLACE_LOCK_PATH}, from before Backoffice kept installation records, then delete the file. Installing into a workspace that still has it is refused. Imported installations approve no permissions and have no settings until the package is installed again, and routes and agents their old install scripts wrote stay members' until then. A listing that already has an installation keeps it. A listing the file records in several folders is a conflict: it is not imported, and the file stays, until keep names the one folder to import; the other folders' files stay where they are. If the file changes while importing, it stays and lock is changed; import again to pick up the changes.`,
    permissions: [BACKOFFICE_PERMISSION.packages.install],
    input: packagesImportLegacyInputSchema,
    output: packagesImportLegacyResultSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
