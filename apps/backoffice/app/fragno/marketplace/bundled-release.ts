import type { PreparedFileBatchEntry } from "@fragno-dev/upload/types";

import { getUploadFileSnapshots } from "@/file-collection/get-upload-file-snapshots";
import {
  createMarketplacePackageUpload,
  transferMarketplacePackageUpload,
} from "@/fragno/automation/marketplace-package-upload";
import {
  throwMarketplaceUploadRouteError,
  throwUnexpectedMarketplaceUploadResponse,
} from "@/fragno/automation/marketplace-upload-errors";
import type { UploadRouteCaller } from "@/fragno/upload-server";
import { sha256Hex } from "@/lib/crypto";

import { marketplaceCreateDraftListingInputSchema } from "./contracts";
import {
  marketplaceRootPackageFilePath,
  prepareMarketplacePackageFiles,
  type MarketplaceStaticPackageEntry,
} from "./package-files";
import {
  captureMarketplaceReleaseSnapshot,
  encodeMarketplaceReleaseBytes,
  type MarketplaceReleaseSnapshot,
} from "./release-snapshot";

/** Bundled files are captured before enqueueing, using the same resolved release shape as workspace packages. */
export async function captureBundledMarketplaceRelease(
  entry: MarketplaceStaticPackageEntry,
): Promise<MarketplaceReleaseSnapshot> {
  const identity = marketplaceCreateDraftListingInputSchema.parse({
    owner: entry.owner,
    slug: entry.slug,
    version: entry.version,
    metadata: entry.metadata,
  });
  const files = await Promise.all(
    prepareMarketplacePackageFiles(entry.files).map(async (file) => {
      const bytes = new TextEncoder().encode(file.content);
      return {
        relativePath: file.relativePath,
        content: encodeMarketplaceReleaseBytes(bytes),
        sizeBytes: bytes.length,
        checksum: await sha256Hex(bytes),
      };
    }),
  );
  return captureMarketplaceReleaseSnapshot({ ...identity, files });
}

/** Listing-root documents are initialized once, independently from immutable version publication. */
export async function initializeMarketplaceListingRootFiles(
  routes: UploadRouteCaller,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  const roots = prepareMarketplacePackageFiles(files).map((file) => ({
    ...file,
    fileKey: marketplaceRootPackageFilePath(file.relativePath),
  }));
  const fileKeys = roots.map((file) => file.fileKey);
  const existing = new Set(
    (await getUploadFileSnapshots({ routes, fileKeys }))
      .filter((file) => file.status === "ready")
      .map((file) => file.fileKey),
  );
  const entries: PreparedFileBatchEntry[] = [];
  for (const file of roots) {
    if (existing.has(file.fileKey)) {
      continue;
    }
    const content = new TextEncoder().encode(file.content);
    const uploadId = await createMarketplacePackageUpload({
      routes,
      file: {
        ...file,
        sizeBytes: content.length,
        checksum: { algo: "sha256", value: await sha256Hex(content) },
      },
    });
    const prepared = await transferMarketplacePackageUpload({ routes, uploadId, content });
    entries.push({ kind: "write", uploadId: prepared.uploadId, precondition: { kind: "absent" } });
  }
  if (entries.length === 0) {
    return;
  }

  const committed = await routes("POST", "/files/commit-prepared", { body: { entries } });
  if (committed.type === "error") {
    if (committed.error.code === "FILE_PRECONDITION_FAILED") {
      // Another seed may initialize the roots while this request prepares its uploads.
      const ready = new Set(
        (await getUploadFileSnapshots({ routes, fileKeys }))
          .filter((file) => file.status === "ready")
          .map((file) => file.fileKey),
      );
      if (fileKeys.every((key) => ready.has(key))) {
        return;
      }
    }
    throwMarketplaceUploadRouteError({
      operation: "Marketplace listing-root initialization",
      status: committed.status,
      error: committed.error,
    });
  }
  if (committed.type !== "json") {
    throwUnexpectedMarketplaceUploadResponse({
      operation: "Marketplace listing-root initialization",
      status: committed.status,
    });
  }
}
