// Marketplace packages: search, inspect, publish, feature. Read to find or publish a package.
type MarketplaceCodemodeProvider = {
  /**
   * Search published package metadata in the public Marketplace, or in the current organization's Marketplace with organization visibility. Follow nextCursor while hasNextPage is true, even when a candidate page has no matches.
   * Requires `marketplace.read`.
   */
  search(input: MarketplaceSearchInput): Promise<MarketplaceSearchOutput>;
  /**
   * Inspect published package metadata and cursor-paginated releases in the public Marketplace, or in the current organization's Marketplace with organization visibility.
   * Requires `marketplace.read`.
   */
  view(input: MarketplaceViewInput): Promise<MarketplaceViewOutput>;
  /**
   * Publish a captured package from a root manifest.json containing name @<organization-slug>/<package-slug>. Public visibility publishes to the public Marketplace; organization visibility publishes to the owning organization's members-only Marketplace. Versions are immutable by default; System may explicitly replace them. Dry runs write nothing. Author and version overrides require System context.
   * Requires `marketplace.publish`.
   */
  publish(input: MarketplacePublishInput): Promise<MarketplacePublishOutput>;
  /**
   * List every feature entry with its state: active, scheduled, expired, or hidden (the listing is no longer published). In System scope this curates the public Marketplace and requires a System administrator; in organization scope it curates that organization's Marketplace and requires an organization owner or admin.
   * Requires `marketplace.read`.
   */
  featured(input: MarketplaceFeaturedInput): Promise<MarketplaceFeaturedOutput>;
};
declare const marketplace: MarketplaceCodemodeProvider;

type MarketplaceSearchInput = {
  category?: "communication" | "developer-tools" | "operations" | "productivity" | "reporting";
  pageSize?: number;
  cursor?: string;
  query: string;
  visibility?: "public" | "organization";
};
type MarketplaceSearchOutput = {
  listings: {
    listingId: string;
    name: string;
    summary: string;
    publisherName: string;
    category: "communication" | "developer-tools" | "operations" | "productivity" | "reporting";
    tags: string[];
    latestVersion: string;
    featured: boolean;
  }[];
  nextCursor: string | null;
  hasNextPage: boolean;
};
type MarketplaceViewInput = {
  listingId: string;
  versionPageSize?: number;
  versionCursor?: string;
  visibility?: "public" | "organization";
};
type MarketplaceViewOutput = {
  listing: {
    name: string;
    summary: string;
    description: string;
    tags: string[];
    category: "communication" | "developer-tools" | "operations" | "productivity" | "reporting";
    listingId: string;
    slug: string;
    publisherName: string;
    status: "published";
    latestVersion: string;
    publishedAt: string;
    updatedAt: string;
    featured: boolean;
  };
  versions: {
    version: string;
    publishedAt: string;
  }[];
  nextVersionCursor?: string;
  hasNextVersionPage: boolean;
};
type MarketplacePublishInput = {
  packageRoot: string;
  visibility: "public" | "organization";
  dryRun?: boolean;
  skipAuthorCheck?: boolean;
  skipVersionCheck?: boolean;
};
type MarketplacePublishOutput =
  | {
      name: string;
      listingId: string;
      version: string;
      snapshotId: string;
      owner: {
        scope: {
          kind: "org";
          orgId: string;
        };
        publisherName: string;
      };
      marketplace:
        | {
            kind: "system";
          }
        | {
            kind: "org";
            orgId: string;
            jurisdiction: "eu" | "us" | null;
          };
      files: {
        relativePath: string;
        sizeBytes: number;
        checksum: string;
      }[];
      sizeBytes: number;
      state: "preview";
    }
  | {
      name: string;
      listingId: string;
      version: string;
      snapshotId: string;
      owner: {
        scope: {
          kind: "org";
          orgId: string;
        };
        publisherName: string;
      };
      marketplace:
        | {
            kind: "system";
          }
        | {
            kind: "org";
            orgId: string;
            jurisdiction: "eu" | "us" | null;
          };
      files: {
        relativePath: string;
        sizeBytes: number;
        checksum: string;
      }[];
      sizeBytes: number;
      state: "requested" | "published";
      workflowInstanceId: string;
      workflowScope: {
        kind: "system";
      };
    };
type MarketplaceFeaturedInput = Record<string, unknown>;
type MarketplaceFeaturedOutput = {
  entries: {
    listingId: string;
    name: string;
    state: "active" | "scheduled" | "expired" | "hidden";
    priority: number;
    note: string | null;
    startsAt: string;
    until: string | null;
    featuredBy: string;
    createdAt: string;
    updatedAt: string;
  }[];
  limit: number;
};
