import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { createUploadFileSystem } from "@/files/contributors/upload";
import type { FilesExplorerTreeNode } from "@/files/explorer-types";
import {
  createPathNotFoundFileSystemError,
  createReadOnlyFileSystemError,
  createUnsupportedOperationFileSystemError,
} from "@/files/fs-errors";
import {
  createUnsupportedFileSystem,
  type BufferEncoding,
  type IFileSystem,
  type ReadFileOptions,
} from "@/files/interface";
import { MasterFileSystem } from "@/files/master-file-system";
import {
  ensureFolderPath,
  isPathWithin,
  normalizeAbsolutePath,
  resolvePath,
  stripTrailingSlash,
} from "@/files/normalize-path";
import { getFilesNodeDetail, listFilesChildren, listFilesTree } from "@/files/service";
import { createSystemFilesContext } from "@/files/system-context";
import type { MarketplaceArtifactManifest } from "@/fragno/marketplace/contracts";
import { UPLOAD_PROVIDER_DATABASE } from "@/fragno/upload";

import {
  MARKETPLACE_ARTIFACT_MOUNT_POINT,
  type MarketplaceArtifactExplorerData,
} from "./artifact-files-model";

const SOURCE_MOUNT_POINT = "/marketplace-artifact-source";
const UNKNOWN_MTIME = new Date(0);

type PublishedArtifactVersion = MarketplaceArtifactManifest["versions"][number];

type ResolvedArtifactPath =
  | { kind: "root" }
  | {
      kind: "version";
      sourcePath: string;
      isVersionRoot: boolean;
    };

export function createPublishedMarketplaceArtifactFileSystem(
  source: IFileSystem,
  versions: readonly PublishedArtifactVersion[],
): IFileSystem {
  const versionsByName = new Map(versions.map((version) => [version.version, version]));

  const resolveArtifactPath = (path: string): ResolvedArtifactPath => {
    const normalizedPath = normalizeAbsolutePath(path);
    if (normalizedPath === MARKETPLACE_ARTIFACT_MOUNT_POINT) {
      return { kind: "root" };
    }
    if (!isPathWithin(normalizedPath, MARKETPLACE_ARTIFACT_MOUNT_POINT)) {
      throw createPathNotFoundFileSystemError("resolve", path);
    }

    const relativePath = normalizedPath.slice(MARKETPLACE_ARTIFACT_MOUNT_POINT.length + 1);
    const [versionName, ...versionPathSegments] = relativePath.split("/");
    const version = versionsByName.get(versionName ?? "");
    if (!version) {
      throw createPathNotFoundFileSystemError("resolve", path);
    }

    const versionPath = versionPathSegments.join("/");
    return {
      kind: "version",
      sourcePath: versionPath
        ? `${SOURCE_MOUNT_POINT}/${version.directory}/${versionPath}`
        : `${SOURCE_MOUNT_POINT}/${version.directory}`,
      isVersionRoot: versionPath.length === 0,
    };
  };

  const statArtifactPath = async (path: string) => {
    const resolved = resolveArtifactPath(path);
    if (resolved.kind === "root" || resolved.isVersionRoot) {
      return {
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
        mode: 0o555,
        size: 0,
        mtime: UNKNOWN_MTIME,
      };
    }
    return source.stat(resolved.sourcePath);
  };

  return createUnsupportedFileSystem(createReadOnlyFileSystemError, {
    async readFile(path: string, options?: ReadFileOptions | BufferEncoding) {
      const resolved = resolveArtifactPath(path);
      if (resolved.kind === "root" || resolved.isVersionRoot) {
        throw createUnsupportedOperationFileSystemError("read", path);
      }
      return source.readFile(resolved.sourcePath, options);
    },
    async readFileBuffer(path: string) {
      const resolved = resolveArtifactPath(path);
      if (resolved.kind === "root" || resolved.isVersionRoot) {
        throw createUnsupportedOperationFileSystemError("read", path);
      }
      return source.readFileBuffer(resolved.sourcePath);
    },
    async readFileStream(path: string) {
      const resolved = resolveArtifactPath(path);
      if (resolved.kind === "root" || resolved.isVersionRoot) {
        throw createUnsupportedOperationFileSystemError("read stream", path);
      }
      if (!source.readFileStream) {
        throw createUnsupportedOperationFileSystemError("read stream", path);
      }
      return source.readFileStream(resolved.sourcePath);
    },
    stat: statArtifactPath,
    async readdir(path: string) {
      const resolved = resolveArtifactPath(path);
      if (resolved.kind === "root") {
        return versions.map((version) => version.version);
      }
      return source.readdir(resolved.sourcePath);
    },
    async readdirWithFileTypes(path: string) {
      const resolved = resolveArtifactPath(path);
      if (resolved.kind === "root") {
        return versions.map((version) => ({
          name: version.version,
          isFile: false,
          isDirectory: true,
          isSymbolicLink: false,
        }));
      }
      if (source.readdirWithFileTypes) {
        return source.readdirWithFileTypes(resolved.sourcePath);
      }
      return Promise.all(
        (await source.readdir(resolved.sourcePath)).map(async (name) => {
          const stat = await source.stat(resolvePath(resolved.sourcePath, name));
          return {
            name,
            isFile: stat.isFile,
            isDirectory: stat.isDirectory,
            isSymbolicLink: stat.isSymbolicLink,
          };
        }),
      );
    },
    resolvePath,
    getAllPaths() {
      return [
        MARKETPLACE_ARTIFACT_MOUNT_POINT,
        ...versions.map((version) => `${MARKETPLACE_ARTIFACT_MOUNT_POINT}/${version.version}`),
      ];
    },
    lstat: statArtifactPath,
    async realpath(path: string) {
      await statArtifactPath(path);
      return stripTrailingSlash(normalizeAbsolutePath(path)) || "/";
    },
  });
}

export async function loadMarketplaceArtifactExplorer(input: {
  fileSystem: IFileSystem;
  requestedPath?: string;
}): Promise<MarketplaceArtifactExplorerData> {
  const master = new MasterFileSystem({
    mounts: [
      {
        id: "marketplace-artifact",
        kind: "custom",
        mountPoint: MARKETPLACE_ARTIFACT_MOUNT_POINT,
        title: "Published versions",
        readOnly: true,
        persistence: "persistent",
        description: "Files published for every available Marketplace version.",
        fs: input.fileSystem,
      },
    ],
  });
  const tree = await listCompleteFilesTree(master);
  const requestedPath = input.requestedPath
    ? normalizeMarketplaceArtifactExplorerPath(input.requestedPath)
    : MARKETPLACE_ARTIFACT_MOUNT_POINT;
  const selectedDetail = await getFilesNodeDetail(master, requestedPath);

  if (selectedDetail) {
    return {
      state: "ready",
      tree,
      selectedPath: requestedPath,
      selectedDetail,
      loadError: null,
    };
  }

  return {
    state: "ready",
    tree,
    selectedPath: MARKETPLACE_ARTIFACT_MOUNT_POINT,
    selectedDetail: await getFilesNodeDetail(master, MARKETPLACE_ARTIFACT_MOUNT_POINT),
    loadError: `Artifact path '${requestedPath}' could not be found.`,
  };
}

export async function loadPublishedMarketplaceArtifactExplorer(input: {
  manifest: MarketplaceArtifactManifest | null;
  objects: BackofficeObjectRegistry;
  request: Request;
  requestedPath?: string;
}): Promise<MarketplaceArtifactExplorerData> {
  if (!input.manifest || input.manifest.versions.length === 0) {
    return {
      state: "unavailable",
      message: "This Marketplace listing has no published artifact files.",
    };
  }

  try {
    const source = createUploadFileSystem(
      createSystemFilesContext({
        origin: new URL(input.request.url).origin,
        request: input.request,
        objects: input.objects,
        execution: {
          actor: { type: "system", id: "marketplace-artifact-reader" },
          scope: { kind: "system" },
        },
        staticFileArtifacts: () => ({}),
      }),
      {
        object: input.objects.upload.forName(input.manifest.uploadName),
        provider: UPLOAD_PROVIDER_DATABASE,
        mountPoint: SOURCE_MOUNT_POINT,
      },
    );
    const fileSystem = createPublishedMarketplaceArtifactFileSystem(
      source,
      input.manifest.versions,
    );
    return await loadMarketplaceArtifactExplorer({
      fileSystem,
      requestedPath: input.requestedPath,
    });
  } catch (error) {
    return {
      state: "error",
      message:
        error instanceof Error ? error.message : "Marketplace artifact files could not be loaded.",
    };
  }
}

async function listCompleteFilesTree(master: MasterFileSystem): Promise<FilesExplorerTreeNode[]> {
  return Promise.all((await listFilesTree(master)).map((root) => populateTreeNode(master, root)));
}

async function populateTreeNode(
  master: MasterFileSystem,
  node: FilesExplorerTreeNode,
): Promise<FilesExplorerTreeNode> {
  if (node.kind === "file") {
    return node;
  }

  const children = node.children ?? (await listFilesChildren(master, ensureFolderPath(node.path)));
  return {
    ...node,
    children: await Promise.all(
      children.map((child) => populateTreeNode(master, { ...child, children: undefined })),
    ),
  };
}

function normalizeMarketplaceArtifactExplorerPath(path: string): string {
  const normalizedPath = normalizeAbsolutePath(path);
  if (!isPathWithin(normalizedPath, MARKETPLACE_ARTIFACT_MOUNT_POINT)) {
    throw new Error(`Artifact path must be inside '${MARKETPLACE_ARTIFACT_MOUNT_POINT}'.`);
  }
  return path.endsWith("/") ? ensureFolderPath(normalizedPath) : normalizedPath;
}
