import type { BackofficeObjectRegistry, UploadObject } from "@/backoffice-runtime/object-registry";
import { createFileTree } from "@/file-collection/create-file-tree";
import { createUploadFileCollection } from "@/file-collection/create-upload-file-collection";
import type { FileCollection, FileContent } from "@/file-collection/file-collection";
import { isPathWithin, normalizeAbsolutePath } from "@/files/normalize-path";
import {
  marketplaceVersionSchema,
  type MarketplaceArtifactManifest,
} from "@/fragno/marketplace/contracts";
import { UPLOAD_PROVIDER_DATABASE } from "@/fragno/upload";
import { createUploadRouteCaller } from "@/fragno/upload-server";

import {
  MARKETPLACE_ARTIFACT_ROOT_PATH,
  type MarketplaceArtifactExplorerData,
} from "./artifact-files-model";

export async function loadPublishedMarketplaceArtifactExplorer(input: {
  manifest: MarketplaceArtifactManifest | null;
  objects: BackofficeObjectRegistry;
  request: Request;
  requestedVersion?: string;
}): Promise<MarketplaceArtifactExplorerData> {
  const manifest = input.manifest;
  if (!isPublishedArtifactManifest(manifest)) {
    return { state: "unavailable", message: "This Marketplace listing has no published files." };
  }

  try {
    const collection = createPublishedMarketplaceArtifactCollection({
      manifest,
      objects: input.objects,
      request: input.request,
    });
    return {
      state: "ready",
      fileTree: await collection.getTree(),
      selectedVersion: resolvePublishedVersion(manifest, input.requestedVersion),
    };
  } catch (error) {
    return {
      state: "error",
      message: error instanceof Error ? error.message : "Marketplace files could not be loaded.",
    };
  }
}

export async function fetchPublishedMarketplaceArtifactFile(input: {
  manifest: MarketplaceArtifactManifest | null;
  objects: BackofficeObjectRegistry;
  request: Request;
  path: string;
}): Promise<Response> {
  const manifest = input.manifest;
  if (!isPublishedArtifactManifest(manifest)) {
    return new Response("Marketplace file is unavailable.", { status: 404 });
  }

  const fileKey = resolveArtifactFileKey(input.path);
  if (!fileKey || !isPublishedArtifactPath(manifest, fileKey)) {
    return new Response("artifactPath must identify a published Marketplace file.", {
      status: 400,
    });
  }

  const collection = createPublishedMarketplaceArtifactCollection({
    manifest,
    objects: input.objects,
    request: input.request,
  });
  const content = await collection.getFile(fileKey);
  return content ? createFileContentResponse(content) : new Response("Not Found", { status: 404 });
}

function createPublishedMarketplaceArtifactCollection(input: {
  manifest: MarketplaceArtifactManifest;
  objects: BackofficeObjectRegistry;
  request: Request;
}): FileCollection {
  const uploadObject = input.objects.upload.forName(input.manifest.uploadName);
  const uploadCollection = createUploadFileCollection({
    routes: createUploadRouteCaller(uploadObject, input.request),
    provider: UPLOAD_PROVIDER_DATABASE,
    getFileResponse: ({ provider, fileKey }) =>
      fetchUploadFile(uploadObject, input.request, provider, fileKey),
  });

  return {
    async getTree() {
      const tree = await uploadCollection.getTree();
      return createFileTree(
        tree.entries.filter((entry) => isPublishedArtifactPath(input.manifest, entry.path)),
      );
    },
    async getFile(path) {
      return isPublishedArtifactPath(input.manifest, path) ? uploadCollection.getFile(path) : null;
    },
  };
}

function fetchUploadFile(
  object: UploadObject,
  request: Request,
  provider: string,
  fileKey: string,
): Promise<Response> {
  const url = new URL("/api/upload/files/by-key/content", request.url);
  url.searchParams.set("provider", provider);
  url.searchParams.set("key", fileKey);
  return object.fetch(new Request(url, { headers: request.headers }));
}

function createFileContentResponse(content: FileContent): Response {
  const headers = new Headers();
  if (content.contentType) {
    headers.set("content-type", content.contentType);
  }
  if (content.sizeBytes !== null) {
    headers.set("content-length", String(content.sizeBytes));
  }
  return new Response(content.body, { headers });
}

function isPublishedArtifactManifest(
  manifest: MarketplaceArtifactManifest | null,
): manifest is MarketplaceArtifactManifest {
  return manifest?.listingStatus === "published" && manifest.versions.length > 0;
}

function isPublishedArtifactPath(manifest: MarketplaceArtifactManifest, path: string): boolean {
  const topLevelName = path.split("/", 1)[0];
  const version = marketplaceVersionSchema.safeParse(topLevelName);
  return !version.success || manifest.versions.includes(version.data);
}

function resolvePublishedVersion(
  manifest: MarketplaceArtifactManifest,
  requestedVersion?: string,
): string {
  return manifest.versions.find((version) => version === requestedVersion) ?? manifest.versions[0];
}

function resolveArtifactFileKey(path: string): string | null {
  if (path.endsWith("/")) {
    return null;
  }

  try {
    const normalizedPath = normalizeAbsolutePath(path);
    if (
      normalizedPath === MARKETPLACE_ARTIFACT_ROOT_PATH ||
      !isPathWithin(normalizedPath, MARKETPLACE_ARTIFACT_ROOT_PATH)
    ) {
      return null;
    }
    return normalizedPath.slice(MARKETPLACE_ARTIFACT_ROOT_PATH.length + 1);
  } catch {
    return null;
  }
}
