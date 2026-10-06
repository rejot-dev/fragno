import { z } from "zod";

import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import { sha256Hex } from "@/lib/crypto";

import {
  marketplaceListingMetadataSchema,
  marketplaceSlugSchema,
  marketplaceVersionSchema,
} from "./contracts";
import {
  MARKETPLACE_RELEASE_LIMITS,
  MARKETPLACE_RELEASE_GUARD_PATH,
  marketplaceReleaseFileSchema,
  marketplaceFileSnapshotId,
  encodeMarketplaceReleaseBytes,
  decodeMarketplaceReleaseBytes,
} from "./release-snapshot";

const packagePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((path) => {
    const relativePath = path.endsWith("/") ? path.slice(0, -1) : path;
    return (
      path === path.trim() &&
      !/[\\\p{Cc}*?[\]{}]/u.test(path) &&
      relativePath.split("/").every((segment) => segment && segment !== "." && segment !== "..")
    );
  }, "Marketplace package files must be relative POSIX paths without traversal or globs.");

/** The scoped package name is the only author-facing owner and package identity. */
export const marketplacePackageManifestSchema = z.strictObject({
  name: z
    .string()
    .max(273)
    .regex(/^@[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/u)
    .refine(
      (name) => marketplaceSlugSchema.safeParse(name.slice(name.indexOf("/") + 1)).success,
      "Marketplace package names use @<organization-slug>/<package-slug>.",
    ),
  version: marketplaceVersionSchema,
  metadata: marketplaceListingMetadataSchema.strict(),
  files: z
    .array(packagePathSchema)
    .min(1)
    .max(MARKETPLACE_RELEASE_LIMITS.files)
    .refine(
      (files) => new Set(files.map((path) => path.replace(/\/$/u, ""))).size === files.length,
      "Marketplace package file selections must be unique.",
    ),
});

/** Binary contents remain opaque until upload; checksums identify the exact captured bytes. */
export const marketplacePackageSnapshotSchema = z.strictObject({
  manifest: marketplacePackageManifestSchema,
  snapshotId: z.string().regex(/^[a-f0-9]{64}$/u),
  files: z.array(marketplaceReleaseFileSchema).min(1).max(MARKETPLACE_RELEASE_LIMITS.files),
});

export type MarketplacePackageSnapshot = z.output<typeof marketplacePackageSnapshotSchema>;

/** Parse once at the manifest boundary; persisted organization IDs are resolved separately. */
export function marketplacePackageIdentity(name: string): {
  organizationSlug: string;
  slug: string;
} {
  const slash = name.indexOf("/");
  return { organizationSlug: name.slice(1, slash), slug: name.slice(slash + 1) };
}

function assertPublishablePackagePath(path: string): void {
  if (
    path === MARKETPLACE_RELEASE_GUARD_PATH ||
    path.endsWith(`/${MARKETPLACE_RELEASE_GUARD_PATH}`) ||
    path
      .split("/")
      .some(
        (segment) =>
          segment === ".git" ||
          segment === ".ssh" ||
          segment === ".aws" ||
          segment === "node_modules" ||
          segment === "marketplace-lock.json" ||
          segment === ".npmrc" ||
          segment === ".env" ||
          segment.startsWith(".env.") ||
          /^(?:credentials\.json|id_rsa|id_ed25519)$/u.test(segment),
      )
  ) {
    throw new Error(`Marketplace package file '${path}' cannot be published.`);
  }
}

/** Capture a bounded, stable file inventory before a publication workflow is accepted. */
export async function captureMarketplacePackageSnapshot(
  state: BackofficeStateBackend,
  packageRoot: string,
): Promise<MarketplacePackageSnapshot> {
  assertPublishablePackagePath(packageRoot);
  state.refreshMetadata();
  const rootStat = await state.lstat(packageRoot);
  if (rootStat?.type !== "directory") {
    throw new Error("Marketplace package root must be an existing directory.");
  }
  const manifestPath = `${packageRoot}/manifest.json`;
  const manifestStat = await state.lstat(manifestPath);
  if (manifestStat?.type !== "file" || manifestStat.size > MARKETPLACE_RELEASE_LIMITS.bytes) {
    throw new Error("Marketplace package root must contain a bounded manifest.json file.");
  }
  const manifestBytes = await state.readFileBytes(manifestPath, MARKETPLACE_RELEASE_LIMITS.bytes);
  const manifest = marketplacePackageManifestSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)),
  );

  async function selectFiles(): Promise<string[]> {
    const selected = new Set(["manifest.json"]);
    async function visit(relativePath: string): Promise<void> {
      assertPublishablePackagePath(relativePath);
      const path = `${packageRoot}/${relativePath}`;
      if ((await state.realpath(path)) !== path) {
        throw new Error(
          `Marketplace package file '${relativePath}' resolves outside its selection.`,
        );
      }
      const stat = await state.lstat(path);
      if (!stat) {
        throw new Error(`Marketplace package file '${relativePath}' does not exist.`);
      }
      if (stat.type === "directory") {
        for (const entry of await state.readdirWithFileTypes(path)) {
          const child = `${relativePath}/${entry.name}`;
          packagePathSchema.parse(child);
          await visit(child);
        }
      } else {
        if (relativePath !== "manifest.json" && selected.has(relativePath)) {
          throw new Error(`Marketplace package contains duplicate file '${relativePath}'.`);
        }
        selected.add(relativePath);
        if (selected.size > MARKETPLACE_RELEASE_LIMITS.files) {
          throw new Error(`Marketplace package exceeds ${MARKETPLACE_RELEASE_LIMITS.files} files.`);
        }
      }
    }
    for (const selection of manifest.files) {
      // Automatic inclusion also permits an explicit manifest allowlist entry.
      if (selection === "manifest.json") {
        continue;
      }
      const path = selection.replace(/\/$/u, "");
      if (
        selection.endsWith("/") &&
        (await state.lstat(`${packageRoot}/${path}`))?.type !== "directory"
      ) {
        throw new Error(`Marketplace package selection '${selection}' must be a directory.`);
      }
      await visit(path);
    }
    return [...selected].sort();
  }

  const paths = await selectFiles();
  const observations = [];
  const files: MarketplacePackageSnapshot["files"] = [];
  let totalBytes = 0;
  for (const relativePath of paths) {
    const path = `${packageRoot}/${relativePath}`;
    const before = await state.lstat(path);
    if (before?.type !== "file" || totalBytes + before.size > MARKETPLACE_RELEASE_LIMITS.bytes) {
      throw new Error(
        `Marketplace package exceeds ${MARKETPLACE_RELEASE_LIMITS.bytes} bytes or changed during capture.`,
      );
    }
    const bytes = await state.readFileBytes(path, MARKETPLACE_RELEASE_LIMITS.bytes - totalBytes);
    totalBytes += bytes.length;
    if (totalBytes > MARKETPLACE_RELEASE_LIMITS.bytes || bytes.length !== before.size) {
      throw new Error("Marketplace package exceeded its byte limit or changed during capture.");
    }
    files.push({
      relativePath,
      content: encodeMarketplaceReleaseBytes(bytes),
      sizeBytes: bytes.length,
      checksum: await sha256Hex(bytes),
    });
    observations.push({
      path,
      size: before.size,
      mtime: before.mtime.getTime(),
      checksum: files[files.length - 1].checksum,
    });
  }
  state.refreshMetadata();
  for (const observation of observations) {
    const current = await state.lstat(observation.path);
    if (
      current?.type !== "file" ||
      current.size !== observation.size ||
      current.mtime.getTime() !== observation.mtime ||
      (await sha256Hex(
        await state.readFileBytes(observation.path, MARKETPLACE_RELEASE_LIMITS.bytes),
      )) !== observation.checksum
    ) {
      throw new Error("Marketplace package changed during capture. Try publishing again.");
    }
  }
  state.refreshMetadata();
  if (
    JSON.stringify(paths) !== JSON.stringify(await selectFiles()) ||
    files.find((file) => file.relativePath === "manifest.json")?.content !==
      encodeMarketplaceReleaseBytes(manifestBytes)
  ) {
    throw new Error("Marketplace package manifest or file selection changed during capture.");
  }
  return { manifest, files, snapshotId: await marketplaceFileSnapshotId(files) };
}

/** Validate externally supplied package bytes before they become immutable workflow input. */
export async function verifyMarketplacePackageSnapshot(
  snapshot: MarketplacePackageSnapshot,
): Promise<void> {
  let totalBytes = 0;
  let previousPath = "";
  for (const file of snapshot.files) {
    assertPublishablePackagePath(file.relativePath);
    if (file.relativePath <= previousPath) {
      throw new Error("Marketplace package snapshot files must be unique and sorted.");
    }
    previousPath = file.relativePath;
    if (
      file.relativePath !== "manifest.json" &&
      !snapshot.manifest.files.some((selection) => {
        const selectedPath = selection.replace(/\/$/u, "");
        return (
          file.relativePath === selectedPath || file.relativePath.startsWith(`${selectedPath}/`)
        );
      })
    ) {
      throw new Error(
        `Marketplace package snapshot file '${file.relativePath}' is not selected by the manifest.`,
      );
    }
    const bytes = decodeMarketplaceReleaseBytes(file.content);
    totalBytes += bytes.length;
    if (bytes.length !== file.sizeBytes || (await sha256Hex(bytes)) !== file.checksum) {
      throw new Error(`Marketplace package snapshot checksum mismatch for '${file.relativePath}'.`);
    }
  }
  const manifestFile = snapshot.files.find((file) => file.relativePath === "manifest.json");
  if (
    !manifestFile ||
    totalBytes > MARKETPLACE_RELEASE_LIMITS.bytes ||
    (await marketplaceFileSnapshotId(snapshot.files)) !== snapshot.snapshotId
  ) {
    throw new Error("Marketplace package snapshot is incomplete or exceeds its byte limit.");
  }
  const capturedManifest = marketplacePackageManifestSchema.parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        decodeMarketplaceReleaseBytes(manifestFile.content),
      ),
    ),
  );
  if (JSON.stringify(capturedManifest) !== JSON.stringify(snapshot.manifest)) {
    throw new Error("Marketplace package snapshot manifest does not match its captured file.");
  }
}
