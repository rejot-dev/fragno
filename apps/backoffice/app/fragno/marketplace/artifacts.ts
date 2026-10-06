import type { UploadFileTreeRecord } from "@/file-collection/create-upload-file-tree";
import { bytesToHex } from "@/lib/crypto";

import type { MarketplaceStaticEntry } from "./contracts";
import { marketplaceListingIdSchema, marketplaceVersionSchema } from "./contracts";

const TEXT_ENCODER = new TextEncoder();

/** Exact inventories recognize committed package files without repeating external writes. */
export function marketplaceArtifactFileInventoryMatches(
  expected: readonly {
    fileKey: string;
    sizeBytes: number;
    checksum: { algo: "sha256"; value: string };
  }[],
  actual: readonly UploadFileTreeRecord[],
): boolean {
  if (actual.length !== expected.length) {
    return false;
  }
  const actualByKey = new Map(actual.map((file) => [file.fileKey, file]));
  return expected.every((file) => {
    const stored = actualByKey.get(file.fileKey);
    return (
      stored?.sizeBytes === file.sizeBytes &&
      stored.checksum?.algo === file.checksum.algo &&
      stored.checksum.value === file.checksum.value
    );
  });
}

export const MARKETPLACE_INSTALL_WORKFLOW_PATH = ".marketplace/install.workflow.js";
export const isMarketplaceInternalArtifactPath = (relativePath: string) =>
  relativePath === ".marketplace" || relativePath.startsWith(".marketplace/");

export type MarketplaceStaticArtifactVersion = Pick<MarketplaceStaticEntry, "version"> & {
  files: Readonly<Record<string, string>>;
};

export type MarketplaceStaticArtifactListing = Omit<MarketplaceStaticEntry, "version"> & {
  rootFiles?: Readonly<Record<string, string>>;
  versions: readonly MarketplaceStaticArtifactVersion[];
};

export type MarketplaceStaticArtifactEntry = MarketplaceStaticEntry & {
  rootFiles?: Readonly<Record<string, string>>;
  files: Readonly<Record<string, string>>;
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

export const marketplaceRootArtifactFilePath = (relativePath: string) => {
  const normalizedPath = normalizeMarketplaceArtifactPath(relativePath);
  const topLevelName = normalizedPath.split("/", 1)[0];
  if (marketplaceVersionSchema.safeParse(topLevelName).success) {
    throw new Error(
      `Marketplace root file path '${relativePath}' conflicts with a version directory.`,
    );
  }
  return normalizedPath;
};

export const marketplaceVersionArtifactFilePath = (version: string, relativePath: string) =>
  `${marketplaceVersionSchema.parse(version)}/${normalizeMarketplaceArtifactPath(relativePath)}`;

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
