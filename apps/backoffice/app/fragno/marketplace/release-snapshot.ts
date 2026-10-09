import {
  marketplaceListingIdSchema,
  marketplaceListingMetadataSchema,
  marketplaceOwnerSchema,
  marketplaceSlugSchema,
  marketplaceVersionSchema,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import { z } from "zod";

import { sha256Hex } from "@/lib/crypto";

import { marketplaceListingId } from "./owner";

/** Capture limits bound durable release input; the publisher's commit guard is additional. */
export const MARKETPLACE_RELEASE_LIMITS = { files: 100, bytes: 1_048_576 } as const;
/** Every release writes this guard so disjoint file sets still share an Upload revision fence. */
export const MARKETPLACE_RELEASE_GUARD_PATH = ".marketplace/publish.json";

/** Captured bytes have no dependency on workspace manifests or bundled-entry formats. */
export const marketplaceReleaseFileSchema = z.strictObject({
  relativePath: z
    .string()
    .min(1)
    .max(512)
    .refine(
      (path) =>
        path === path.trim() &&
        !/[\\\p{Cc}*?[\]{}]/u.test(path) &&
        path.split("/").every((segment) => segment && segment !== "." && segment !== "..") &&
        path !== MARKETPLACE_RELEASE_GUARD_PATH,
      "Marketplace release files must be relative POSIX paths and cannot replace the publisher's guard.",
    ),
  content: z
    .string()
    .max(Math.ceil(MARKETPLACE_RELEASE_LIMITS.bytes / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
  sizeBytes: z.number().int().nonnegative().max(MARKETPLACE_RELEASE_LIMITS.bytes),
  checksum: z.string().regex(/^[a-f0-9]{64}$/u),
});

const releaseContentsSchema = z.strictObject({
  owner: marketplaceOwnerSchema,
  slug: marketplaceSlugSchema,
  version: marketplaceVersionSchema,
  metadata: marketplaceListingMetadataSchema.strict(),
  files: z.array(marketplaceReleaseFileSchema).min(1).max(MARKETPLACE_RELEASE_LIMITS.files),
});

/** Resolved ownership, metadata, and exact files are frozen before any workflow is accepted. */
export const marketplaceReleaseSnapshotSchema = releaseContentsSchema
  .extend({
    listingId: marketplaceListingIdSchema,
    snapshotId: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .superRefine((release, context) => {
    if (
      release.listingId !==
      marketplaceListingId({ ownerScope: release.owner.scope, slug: release.slug })
    ) {
      context.addIssue({
        code: "custom",
        message: "Marketplace release identity must match its owner and slug.",
      });
    }
  });
export type MarketplaceReleaseSnapshot = z.output<typeof marketplaceReleaseSnapshotSchema>;
export type MarketplaceReleaseFile = z.output<typeof marketplaceReleaseFileSchema>;

/** Snapshot encoding preserves binary bytes without interpreting authored code. */
export function encodeMarketplaceReleaseBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

/** Decode captured artifact bytes at the Upload boundary. */
export function decodeMarketplaceReleaseBytes(content: string): Uint8Array {
  return Uint8Array.from(atob(content), (character) => character.charCodeAt(0));
}

/** File identity uses exact paths and checksums in canonical path order. */
export async function marketplaceFileSnapshotId(
  files: readonly MarketplaceReleaseFile[],
): Promise<string> {
  return sha256Hex(
    new TextEncoder().encode(
      JSON.stringify(
        files.map(({ relativePath, checksum, sizeBytes }) => [relativePath, checksum, sizeBytes]),
      ),
    ),
  );
}

/** Normalize both capture adapters without manufacturing an organization-scoped package manifest. */
export async function captureMarketplaceReleaseSnapshot(
  rawInput: z.input<typeof releaseContentsSchema>,
): Promise<MarketplaceReleaseSnapshot> {
  const { owner, slug, version, metadata, files: inputFiles } = rawInput;
  const input = releaseContentsSchema.parse({ owner, slug, version, metadata, files: inputFiles });
  const files = [...input.files].sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
  );
  const snapshotId = await marketplaceReleaseFingerprint({ ...input, files });
  return {
    ...input,
    files,
    listingId: marketplaceListingId({ ownerScope: input.owner.scope, slug: input.slug }),
    snapshotId,
  };
}

function marketplaceReleaseFingerprint(
  release: Pick<MarketplaceReleaseSnapshot, "owner" | "slug" | "version" | "metadata" | "files">,
): Promise<string> {
  return sha256Hex(
    new TextEncoder().encode(
      JSON.stringify([
        release.owner,
        release.slug,
        release.version,
        release.metadata,
        release.files.map(({ relativePath, checksum, sizeBytes }) => [
          relativePath,
          checksum,
          sizeBytes,
        ]),
      ]),
    ),
  );
}

/** RPC-supplied releases earn trust before domain logic or durable enqueueing. */
export async function verifyMarketplaceReleaseSnapshot(
  release: MarketplaceReleaseSnapshot,
): Promise<void> {
  let bytes = 0;
  let previousPath = "";
  for (const file of release.files) {
    if (file.relativePath <= previousPath) {
      throw new Error("Marketplace release files must be unique and sorted.");
    }
    previousPath = file.relativePath;
    const content = decodeMarketplaceReleaseBytes(file.content);
    bytes += content.length;
    if (content.length !== file.sizeBytes || (await sha256Hex(content)) !== file.checksum) {
      throw new Error(
        `Marketplace release checksum or size is invalid for '${file.relativePath}'.`,
      );
    }
  }
  if (
    bytes > MARKETPLACE_RELEASE_LIMITS.bytes ||
    (await marketplaceReleaseFingerprint(release)) !== release.snapshotId
  ) {
    throw new Error(
      "Marketplace release exceeds capture limits or has an invalid snapshot fingerprint.",
    );
  }
}

/** Commit the publisher-owned guard alongside authored files, including metadata-only replacements. */
export async function marketplaceReleaseArtifactFiles(
  release: MarketplaceReleaseSnapshot,
): Promise<MarketplaceReleaseFile[]> {
  const content = new TextEncoder().encode(JSON.stringify({ snapshotId: release.snapshotId }));
  return [
    ...release.files,
    {
      relativePath: MARKETPLACE_RELEASE_GUARD_PATH,
      content: encodeMarketplaceReleaseBytes(content),
      sizeBytes: content.length,
      checksum: await sha256Hex(content),
    },
  ].sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
  );
}
