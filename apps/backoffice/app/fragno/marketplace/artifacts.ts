import { bytesToHex } from "@/lib/crypto";

import type { MarketplaceStaticEntry } from "./contracts";
import { marketplaceListingIdSchema, marketplaceVersionSchema } from "./contracts";

const TEXT_ENCODER = new TextEncoder();

export type MarketplaceStaticArtifactEntry = MarketplaceStaticEntry & {
  files: Readonly<Record<string, string>>;
};

export type MarketplaceArtifactFile = {
  relativePath: string;
  content: Uint8Array;
};

export const marketplaceArtifactUploadName = (listingId: string) =>
  `marketplace/listings/${bytesToHex(
    TEXT_ENCODER.encode(marketplaceListingIdSchema.parse(listingId)),
  )}`;

export const marketplaceArtifactDirectory = (version: string) =>
  marketplaceVersionSchema.parse(version);

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

export const marketplaceArtifactFilePath = (directory: string, relativePath: string) =>
  `${marketplaceArtifactDirectory(directory)}/${normalizeMarketplaceArtifactPath(relativePath)}`;

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
      content: TEXT_ENCODER.encode(source),
    };
  });

  return prepared.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
};
