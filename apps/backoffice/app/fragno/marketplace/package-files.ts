import {
  marketplaceListingIdSchema,
  marketplaceVersionSchema,
  type MarketplaceScope,
} from "@fragno-dev/backoffice-api/v0/marketplace";

import type { UploadFileTreeRecord } from "@/file-collection/create-upload-file-tree";
import { bytesToHex } from "@/lib/crypto";

import type { MarketplaceStaticEntry } from "./contracts";

const TEXT_ENCODER = new TextEncoder();

/** Exact inventories recognize committed package files without repeating external writes. */
export function marketplacePackageFileInventoryMatches(
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
export const isMarketplaceInternalPackagePath = (relativePath: string) =>
  relativePath === ".marketplace" || relativePath.startsWith(".marketplace/");

export type MarketplaceStaticPackageVersion = Pick<MarketplaceStaticEntry, "version"> & {
  files: Readonly<Record<string, string>>;
};

export type MarketplaceStaticPackageListing = Omit<MarketplaceStaticEntry, "version"> & {
  rootFiles?: Readonly<Record<string, string>>;
  versions: readonly MarketplaceStaticPackageVersion[];
};

export type MarketplaceStaticPackageEntry = MarketplaceStaticEntry & {
  rootFiles?: Readonly<Record<string, string>>;
  files: Readonly<Record<string, string>>;
};

export type MarketplacePackageFile = {
  relativePath: string;
  content: string;
};

/** Listing ids repeat across Marketplaces, so organization packages are namespaced by their Marketplace. */
export function marketplacePackageUploadName({
  marketplace,
  listingId,
}: {
  marketplace: MarketplaceScope;
  listingId: string;
}): string {
  const listing = `listings/${bytesToHex(TEXT_ENCODER.encode(marketplaceListingIdSchema.parse(listingId)))}`;
  return marketplace.kind === "system"
    ? `marketplace/${listing}`
    : `marketplace/org/${bytesToHex(TEXT_ENCODER.encode(marketplace.orgId))}/${listing}`;
}

export const normalizeMarketplacePackagePath = (path: string): string => {
  const trimmed = path.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("\\")) {
    throw new Error(`Marketplace package path '${path}' must be a relative POSIX path.`);
  }

  const segments = trimmed.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Marketplace package path '${path}' contains an invalid path segment.`);
  }

  return segments.join("/");
};

export const marketplaceRootPackageFilePath = (relativePath: string) => {
  const normalizedPath = normalizeMarketplacePackagePath(relativePath);
  const topLevelName = normalizedPath.split("/", 1)[0];
  if (marketplaceVersionSchema.safeParse(topLevelName).success) {
    throw new Error(
      `Marketplace root file path '${relativePath}' conflicts with a version directory.`,
    );
  }
  return normalizedPath;
};

export const marketplaceVersionPackageFilePath = (version: string, relativePath: string) =>
  `${marketplaceVersionSchema.parse(version)}/${normalizeMarketplacePackagePath(relativePath)}`;

export const prepareMarketplacePackageFiles = (
  files: Readonly<Record<string, string>>,
): MarketplacePackageFile[] => {
  const normalizedPaths = new Set<string>();
  const prepared = Object.entries(files).map(([path, source]) => {
    const relativePath = normalizeMarketplacePackagePath(path);
    if (normalizedPaths.has(relativePath)) {
      throw new Error(`Marketplace package contains duplicate path '${relativePath}'.`);
    }
    normalizedPaths.add(relativePath);

    return {
      relativePath,
      content: source,
    };
  });

  return prepared.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
};
