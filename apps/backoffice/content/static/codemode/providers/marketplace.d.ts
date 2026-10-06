// marketplace tools
type MarketplaceCodemodeProvider = {
  /** Search published package metadata. Follow nextCursor while hasNextPage is true, even when a candidate page has no matches. */
  search(input: MarketplaceSearchInput): Promise<MarketplaceSearchOutput>;
  /** Inspect published package metadata and cursor-paginated releases. */
  view(input: MarketplaceViewInput): Promise<MarketplaceViewOutput>;
  /** Publish a captured package from a root manifest.json containing name @<organization-slug>/<package-slug>. Versions are immutable by default; System may explicitly replace them. Dry runs write nothing. Author and version overrides require System context. */
  publish(input: MarketplacePublishInput): Promise<MarketplacePublishOutput>;
};
declare const marketplace: MarketplaceCodemodeProvider;

type MarketplaceSearchInput = {
  category?: "communication" | "developer-tools" | "operations" | "productivity" | "reporting";
  pageSize?: number;
  cursor?: string;
  query: string;
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
  }[];
  nextCursor: string | null;
  hasNextPage: boolean;
};
type MarketplaceViewInput = {
  listingId: string;
  versionPageSize?: number;
  versionCursor?: string;
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
