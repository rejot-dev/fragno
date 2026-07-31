import { bytesToHex } from "@/lib/crypto";

import type { MarketplaceStaticEntry } from "./contracts";
import { marketplaceListingIdSchema, marketplaceVersionSchema } from "./contracts";

const TEXT_ENCODER = new TextEncoder();

export type MarketplaceStaticArtifactVersion = Pick<MarketplaceStaticEntry, "version"> & {
  files: Readonly<Record<string, string>>;
};

export type MarketplaceStaticArtifactListing = Omit<MarketplaceStaticEntry, "version"> & {
  listingFiles?: Readonly<Record<string, string>>;
  versions: readonly MarketplaceStaticArtifactVersion[];
};

export type MarketplaceStaticArtifactEntry = MarketplaceStaticEntry & {
  files: Readonly<Record<string, string>>;
  listingFiles?: Readonly<Record<string, string>>;
};

export type MarketplaceArtifactFile = {
  relativePath: string;
  content: string;
};

export const marketplaceArtifactUploadName = (listingId: string) =>
  `marketplace/listings/${bytesToHex(
    TEXT_ENCODER.encode(marketplaceListingIdSchema.parse(listingId)),
  )}`;

export const normalizeMarketplaceArtifactPath = (path: string): string => {
  const trimmed = path.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("\\")) {
    throw new Error(`Marketplace artifact path '${path}' must be a relative POSIX path.`);
  }

  const segments = trimmed.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Marketplace artifact path '${path}' contains an invalid path segment.`);
  }

  return segments.join("/");
};

export const MARKETPLACE_LISTING_FILES_DIRECTORY = ".listing";

export const marketplaceVersionArtifactFilePath = (directory: string, relativePath: string) => {
  const normalizedPath = normalizeMarketplaceArtifactPath(relativePath);
  if (normalizedPath.split("/", 1)[0] === MARKETPLACE_LISTING_FILES_DIRECTORY) {
    throw new Error(
      `Marketplace version file path '${relativePath}' uses the reserved listing files directory.`,
    );
  }

  return `${marketplaceVersionSchema.parse(directory)}/${normalizedPath}`;
};

export const marketplaceListingArtifactFilePath = (directory: string, relativePath: string) => {
  const normalizedPath = normalizeMarketplaceArtifactPath(relativePath);
  const topLevelName = normalizedPath.split("/", 1)[0];
  if (marketplaceVersionSchema.safeParse(topLevelName).success) {
    throw new Error(
      `Marketplace listing file path '${relativePath}' conflicts with a version directory.`,
    );
  }

  return `${marketplaceVersionSchema.parse(directory)}/${MARKETPLACE_LISTING_FILES_DIRECTORY}/${normalizedPath}`;
};

export const prepareMarketplaceArtifactFiles = (
  files: Readonly<Record<string, string>>,
): MarketplaceArtifactFile[] => {
  const normalizedPaths = new Set<string>();
  const prepared = Object.entries(files).map(([path, source]) => {
    const relativePath = normalizeMarketplaceArtifactPath(path);
    if (normalizedPaths.has(relativePath)) {
      throw new Error(`Marketplace artifact contains duplicate path '${relativePath}'.`);
    }
    normalizedPaths.add(relativePath);

    return {
      relativePath,
      content: source,
    };
  });

  return prepared.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
};
