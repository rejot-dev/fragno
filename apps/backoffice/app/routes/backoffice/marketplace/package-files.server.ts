import { marketplaceVersionSchema } from "@fragno-dev/backoffice-api/v0/marketplace";

import type {
  BackofficeObjectHandle,
  BackofficeObjectRegistry,
  UploadCommands,
} from "@/backoffice-runtime/object-registry";
import { createFileTree } from "@/file-collection/create-file-tree";
import { createUploadFileCollection } from "@/file-collection/create-upload-file-collection";
import type { FileCollection, FileContent, FileTree } from "@/file-collection/file-collection";
import { isPathWithin, normalizeAbsolutePath } from "@/files/normalize-path";
import { type MarketplaceListingStorage } from "@/fragno/marketplace/contracts";
import { createUploadRouteCaller } from "@/fragno/upload-server";

import {
  MARKETPLACE_PACKAGE_ROOT_PATH,
  type MarketplacePackageExplorerData,
} from "./package-files-model";

export async function loadPublishedMarketplacePackageExplorer(input: {
  manifest: MarketplaceListingStorage | null;
  objects: BackofficeObjectRegistry;
  request: Request;
  requestedVersion?: string;
}): Promise<MarketplacePackageExplorerData> {
  const manifest = input.manifest;
  if (!isPublishedListingStorage(manifest)) {
    return { state: "unavailable", message: "This Marketplace listing has no published files." };
  }

  try {
    const collection = createPublishedMarketplacePackageCollection({
      manifest,
      objects: input.objects,
      request: input.request,
    });
    const fileTree = await collection.getTree();
    const selectedVersion = resolvePublishedVersion(manifest, input.requestedVersion);
    return {
      state: "ready",
      fileTree,
      selectedVersion,
      overviewPath: resolveOverviewPath(fileTree, selectedVersion),
    };
  } catch (error) {
    return {
      state: "error",
      message: error instanceof Error ? error.message : "Marketplace files could not be loaded.",
    };
  }
}

export async function fetchPublishedMarketplacePackageFile(input: {
  manifest: MarketplaceListingStorage | null;
  objects: BackofficeObjectRegistry;
  request: Request;
  path: string;
}): Promise<Response> {
  const manifest = input.manifest;
  if (!isPublishedListingStorage(manifest)) {
    return new Response("Marketplace file is unavailable.", { status: 404 });
  }

  const fileKey = resolvePackageFileKey(input.path);
  if (!fileKey || !isPublishedPackagePath(manifest, fileKey)) {
    return new Response("packagePath must identify a published Marketplace file.", {
      status: 400,
    });
  }

  const collection = createPublishedMarketplacePackageCollection({
    manifest,
    objects: input.objects,
    request: input.request,
  });
  const content = await collection.getFile(fileKey);
  return content ? createFileContentResponse(content) : new Response("Not Found", { status: 404 });
}

function createPublishedMarketplacePackageCollection(input: {
  manifest: MarketplaceListingStorage;
  objects: BackofficeObjectRegistry;
  request: Request;
}): Pick<FileCollection, "getTree" | "getFile"> {
  const uploadObject = input.objects.upload.forName(input.manifest.uploadName);
  const uploadCollection = createUploadFileCollection({
    routes: createUploadRouteCaller(uploadObject.http, input.request),
    // Shared listing storage spans releases; retain a page budget for each version and listing-root files.
    maxPages: input.manifest.versions.length + 1,
    getFileResponse: ({ fileKey }) => fetchUploadFile(uploadObject, input.request, fileKey),
  });

  return {
    async getTree() {
      const tree = await uploadCollection.getTree();
      return createFileTree(
        tree.entries.filter((entry) => isPublishedPackagePath(input.manifest, entry.path)),
      );
    },
    async getFile(path) {
      if (!isPublishedPackagePath(input.manifest, path)) {
        return null;
      }
      return await uploadCollection.getFile(path);
    },
  };
}

function fetchUploadFile(
  object: BackofficeObjectHandle<UploadCommands>,
  request: Request,
  fileKey: string,
): Promise<Response> {
  const url = new URL("/api/upload/files/by-key/content", request.url);
  url.searchParams.set("key", fileKey);
  return object.http.fetch(new Request(url, { headers: request.headers }));
}

function createFileContentResponse(content: FileContent): Response {
  // Author-controlled HTML/SVG must not execute with Backoffice's origin when opened directly.
  const headers = new Headers({
    "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    "x-content-type-options": "nosniff",
  });
  if (content.contentType) {
    headers.set("content-type", content.contentType);
  }
  if (content.sizeBytes !== null) {
    headers.set("content-length", String(content.sizeBytes));
  }
  return new Response(content.body, { headers });
}

function isPublishedListingStorage(
  manifest: MarketplaceListingStorage | null,
): manifest is MarketplaceListingStorage {
  return manifest?.listingStatus === "published" && manifest.versions.length > 0;
}

function isPublishedPackagePath(manifest: MarketplaceListingStorage, path: string): boolean {
  const topLevelName = path.split("/", 1)[0];
  const version = marketplaceVersionSchema.safeParse(topLevelName);
  return !version.success || manifest.versions.includes(version.data);
}

function resolvePublishedVersion(
  manifest: MarketplaceListingStorage,
  requestedVersion?: string,
): string {
  return manifest.versions.find((version) => version === requestedVersion) ?? manifest.versions[0];
}

/** The listing README introduces every release; a release's own README stands in without one. */
function resolveOverviewPath(fileTree: FileTree, selectedVersion: string): string | null {
  const path = ["README.md", `${selectedVersion}/README.md`].find((candidate) =>
    fileTree.entries.some((entry) => entry.kind === "file" && entry.path === candidate),
  );
  return path ? `${MARKETPLACE_PACKAGE_ROOT_PATH}/${path}` : null;
}

function resolvePackageFileKey(path: string): string | null {
  if (path.endsWith("/")) {
    return null;
  }

  try {
    const normalizedPath = normalizeAbsolutePath(path);
    if (
      normalizedPath === MARKETPLACE_PACKAGE_ROOT_PATH ||
      !isPathWithin(normalizedPath, MARKETPLACE_PACKAGE_ROOT_PATH)
    ) {
      return null;
    }
    return normalizedPath.slice(MARKETPLACE_PACKAGE_ROOT_PATH.length + 1);
  } catch {
    return null;
  }
}
