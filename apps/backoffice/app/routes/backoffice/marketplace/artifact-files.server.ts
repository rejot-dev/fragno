import type { FileMetadata } from "@fragno-dev/upload/types";

import type { BackofficeObjectRegistry, UploadObject } from "@/backoffice-runtime/object-registry";
import type { FilesNodeDetail } from "@/files/explorer-types";
import { ensureFolderPath, isPathWithin, normalizeAbsolutePath } from "@/files/normalize-path";
import { MARKETPLACE_LISTING_FILES_DIRECTORY } from "@/fragno/marketplace/artifacts";
import type { MarketplaceArtifactManifest } from "@/fragno/marketplace/contracts";
import { UPLOAD_PROVIDER_DATABASE } from "@/fragno/upload";
import { createUploadRouteCaller, type UploadRouteCaller } from "@/fragno/upload-server";
import type { UploadFileRecord } from "@/fragno/upload/file-record";
import {
  buildLocalUploadExplorer,
  getLocalUploadDetail,
  type UploadExplorerMount,
} from "@/routes/backoffice/files/upload-local-tree";

import {
  MARKETPLACE_ARTIFACT_MOUNT_POINT,
  type MarketplaceArtifactExplorerData,
} from "./artifact-files-model";

const PAGE_SIZE = "500";
const ARTIFACT_MOUNT = {
  id: "marketplace-artifact",
  kind: "custom",
  mountPoint: MARKETPLACE_ARTIFACT_MOUNT_POINT,
  title: "Package contents",
  readOnly: true,
  persistence: "persistent",
  uploadProvider: UPLOAD_PROVIDER_DATABASE,
  description: "Files published for this Marketplace package.",
} satisfies UploadExplorerMount;

type PublishedArtifactVersion = MarketplaceArtifactManifest["versions"][number];

export async function loadPublishedMarketplaceArtifactExplorer(input: {
  manifest: MarketplaceArtifactManifest | null;
  objects: BackofficeObjectRegistry;
  request: Request;
  requestedVersion?: string;
}): Promise<MarketplaceArtifactExplorerData> {
  if (!isPublishedArtifactManifest(input.manifest)) {
    return { state: "unavailable", message: "This Marketplace listing has no published files." };
  }

  try {
    const selectedVersion = resolvePublishedVersion(input.manifest, input.requestedVersion);
    const latestVersion = input.manifest.versions[0];
    const routes = createUploadRouteCaller(
      input.objects.upload.forName(input.manifest.uploadName),
      input.request,
    );
    const versionPrefix = `${selectedVersion.directory}/`;
    const listingPrefix = `${latestVersion.directory}/${MARKETPLACE_LISTING_FILES_DIRECTORY}/`;
    const versionFiles = await listUploadFiles(routes, versionPrefix);
    const listingFiles =
      selectedVersion.directory === latestVersion.directory
        ? versionFiles
        : await listUploadFiles(routes, listingPrefix);
    const publishedVersionNames = new Set(input.manifest.versions.map(({ version }) => version));
    const projectedFiles = [
      ...projectUploadFiles(listingFiles, listingPrefix).filter(
        ({ fileKey }) => !publishedVersionNames.has(fileKey.split("/")[0] ?? ""),
      ),
      ...projectUploadFiles(
        versionFiles.filter(
          ({ fileKey }) =>
            !fileKey.startsWith(`${versionPrefix}${MARKETPLACE_LISTING_FILES_DIRECTORY}/`),
        ),
        versionPrefix,
        `${selectedVersion.version}/`,
      ),
    ];
    const explorer = buildLocalUploadExplorer([ARTIFACT_MOUNT], projectedFiles, null);
    const defaultPath = ensureFolderPath(
      `${MARKETPLACE_ARTIFACT_MOUNT_POINT}/${selectedVersion.version}`,
    );
    const detailsByPath: Record<string, FilesNodeDetail> = {};
    for (const path of explorer.nodesByPath.keys()) {
      const detail = getLocalUploadDetail(explorer, path, null);
      if (detail?.node.path === path) {
        detailsByPath[path] = detail;
      }
    }

    return {
      state: "ready",
      tree: explorer.roots,
      selectedVersion: selectedVersion.version,
      defaultPath,
      detailsByPath,
      overviewPath: detailsByPath[`${MARKETPLACE_ARTIFACT_MOUNT_POINT}/README.md`]
        ? `${MARKETPLACE_ARTIFACT_MOUNT_POINT}/README.md`
        : null,
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
  requestedVersion?: string;
}): Promise<Response> {
  if (!isPublishedArtifactManifest(input.manifest)) {
    return new Response("Marketplace file is unavailable.", { status: 404 });
  }

  const normalizedPath = parseMarketplaceArtifactFilePath(input.path);
  if (!normalizedPath) {
    return new Response("artifactPath must identify a published Marketplace file.", {
      status: 400,
    });
  }

  const selectedVersion = resolvePublishedVersion(input.manifest, input.requestedVersion);
  const fileKey = resolveArtifactFileKey(input.manifest, selectedVersion, normalizedPath);
  if (!fileKey) {
    return new Response("Marketplace file is unavailable.", { status: 404 });
  }
  return fetchUploadFile(
    input.objects.upload.forName(input.manifest.uploadName),
    input.request,
    fileKey,
  );
}

function isPublishedArtifactManifest(
  manifest: MarketplaceArtifactManifest | null,
): manifest is MarketplaceArtifactManifest {
  return manifest?.listingStatus === "published" && manifest.versions.length > 0;
}

async function listUploadFiles(routes: UploadRouteCaller, prefix: string): Promise<FileMetadata[]> {
  const response = await routes("GET", "/files", {
    query: {
      provider: UPLOAD_PROVIDER_DATABASE,
      prefix,
      status: "ready",
      pageSize: PAGE_SIZE,
    },
  });
  if (response.type !== "json" || response.status < 200 || response.status >= 300) {
    const code = response.type === "error" ? response.error.code : `HTTP_${response.status}`;
    throw new Error(`Upload file listing failed (${code}).`);
  }
  if (response.data.hasNextPage) {
    throw new Error(`Marketplace artifact file listing exceeds the ${PAGE_SIZE}-file limit.`);
  }

  return response.data.files;
}

function fetchUploadFile(
  object: UploadObject,
  request: Request,
  fileKey: string,
): Promise<Response> {
  const url = new URL("/api/upload/files/by-key/content", request.url);
  url.searchParams.set("provider", UPLOAD_PROVIDER_DATABASE);
  url.searchParams.set("key", fileKey);
  return object.fetch(new Request(url, { headers: request.headers }));
}

function projectUploadFiles(
  files: readonly FileMetadata[],
  sourcePrefix: string,
  targetPrefix = "",
): UploadFileRecord[] {
  return files.flatMap((file): UploadFileRecord[] =>
    file.fileKey.startsWith(sourcePrefix)
      ? [
          {
            ...file,
            tags: file.tags ?? undefined,
            fileKey: `${targetPrefix}${file.fileKey.slice(sourcePrefix.length)}`,
          },
        ]
      : [],
  );
}

function resolvePublishedVersion(
  manifest: MarketplaceArtifactManifest,
  requestedVersion?: string,
): PublishedArtifactVersion {
  const version =
    manifest.versions.find(({ version }) => version === requestedVersion) ?? manifest.versions[0];
  if (!version) {
    throw new Error("Marketplace artifact manifest has no published versions.");
  }
  return version;
}

function parseMarketplaceArtifactFilePath(path: string): string | null {
  if (path.endsWith("/")) {
    return null;
  }

  try {
    const normalizedPath = normalizeAbsolutePath(path);
    return normalizedPath !== MARKETPLACE_ARTIFACT_MOUNT_POINT &&
      isPathWithin(normalizedPath, MARKETPLACE_ARTIFACT_MOUNT_POINT)
      ? normalizedPath
      : null;
  } catch {
    return null;
  }
}

function resolveArtifactFileKey(
  manifest: MarketplaceArtifactManifest,
  selectedVersion: PublishedArtifactVersion,
  normalizedPath: string,
): string | null {
  const versionRoot = `${MARKETPLACE_ARTIFACT_MOUNT_POINT}/${selectedVersion.version}`;
  if (isPathWithin(normalizedPath, versionRoot)) {
    if (normalizedPath === versionRoot) {
      return null;
    }
    const relativePath = normalizedPath.slice(versionRoot.length + 1);
    if (relativePath.startsWith(`${MARKETPLACE_LISTING_FILES_DIRECTORY}/`)) {
      return null;
    }
    return `${selectedVersion.directory}/${relativePath}`;
  }

  const relativePath = normalizedPath.slice(MARKETPLACE_ARTIFACT_MOUNT_POINT.length + 1);
  const topLevelName = relativePath.split("/")[0];
  if (manifest.versions.some(({ version }) => version === topLevelName)) {
    return null;
  }
  return `${manifest.versions[0].directory}/${MARKETPLACE_LISTING_FILES_DIRECTORY}/${relativePath}`;
}
