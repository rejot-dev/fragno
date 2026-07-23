import type { FileMountMetadata, FilesExplorerTreeNode, FilesNodeDetail } from "@/files";
import {
  getUploadDirectoryMarkerFolderKey,
  isUploadDirectoryMarker,
} from "@/files/contributors/upload-markers";
import type { UploadProvider } from "@/fragno/upload";
import type { UploadFileRecord } from "@/fragno/upload/file-record";

export type UploadExplorerMount = FileMountMetadata & {
  uploadProvider: UploadProvider;
};

type LocalUploadNode = {
  explorerNode: FilesExplorerTreeNode;
  metadata: Record<string, unknown> | null;
  children: LocalUploadNode[];
};

type LocalUploadExplorer = {
  roots: FilesExplorerTreeNode[];
  nodesByPath: ReadonlyMap<string, LocalUploadNode>;
};

const NODE_SORTER = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function isUploadExplorerMount(mount: FileMountMetadata): mount is UploadExplorerMount {
  return mount.kind === "upload" && mount.uploadProvider !== undefined;
}

export function buildLocalUploadExplorer(
  mounts: readonly UploadExplorerMount[],
  files: readonly UploadFileRecord[],
  orgId: string,
): LocalUploadExplorer {
  const nodesByPath = new Map<string, LocalUploadNode>();
  const roots = mounts.map((mount) => {
    const root = createRootNode(mount);
    nodesByPath.set(root.explorerNode.path, root);

    const folderNodes = new Map<string, LocalUploadNode>();
    const ensureFolder = (folderKey: string): LocalUploadNode => {
      const normalizedFolderKey = normalizeFileKey(folderKey);
      const folderPath = `${mount.mountPoint}/${normalizedFolderKey}/`;
      const existing = folderNodes.get(folderPath);
      if (existing) {
        return existing;
      }

      const folder = createFolderNode(mount, folderPath);
      folderNodes.set(folderPath, folder);
      nodesByPath.set(folderPath, folder);
      nodesByPath.set(folderPath.slice(0, -1), folder);

      const parentKey = getParentFileKey(normalizedFolderKey);
      const parent = parentKey ? ensureFolder(parentKey) : root;
      parent.children.push(folder);
      return folder;
    };

    for (const file of files) {
      if (file.provider !== mount.uploadProvider || file.status !== "ready" || file.deletedAt) {
        continue;
      }

      if (isUploadDirectoryMarker(file)) {
        const folderKey = getUploadDirectoryMarkerFolderKey(file.fileKey);
        if (!folderKey) {
          continue;
        }

        const folder = ensureFolder(folderKey);
        folder.metadata = file.metadata ?? null;
        folder.explorerNode.updatedAt = readUploadMtime(file);
        continue;
      }

      const fileKey = normalizeFileKey(file.fileKey);
      if (!fileKey) {
        continue;
      }

      const parentKey = getParentFileKey(fileKey);
      const parent = parentKey ? ensureFolder(parentKey) : root;
      const fileNode = createFileNode(mount, file, orgId);
      parent.children.push(fileNode);
      nodesByPath.set(fileNode.explorerNode.path, fileNode);
    }

    sortNodeChildren(root);
    updateFolderCounts(root);
    return root.explorerNode;
  });

  return { roots, nodesByPath };
}

export function getLocalUploadDetail(
  explorer: LocalUploadExplorer,
  path: string,
  textContent: string | null,
): FilesNodeDetail | null {
  const node = explorer.nodesByPath.get(path);
  if (!node) {
    return null;
  }

  const { explorerNode } = node;
  return {
    node: explorerNode,
    description:
      explorerNode.description ??
      (explorerNode.kind === "root"
        ? `Top-level mount at ${explorerNode.mountPoint}.`
        : `${capitalize(explorerNode.kind)} in ${explorerNode.mountTitle}.`),
    fields: createDetailFields(explorerNode),
    metadata: node.metadata,
    textContent: explorerNode.kind === "file" ? textContent : null,
    capabilities: {
      canCreateFolder: !explorerNode.readOnly && explorerNode.kind !== "file",
      canWriteText: !explorerNode.readOnly && explorerNode.kind === "file",
      canDelete: !explorerNode.readOnly && explorerNode.kind !== "root",
    },
  };
}

function createRootNode(mount: UploadExplorerMount): LocalUploadNode {
  return {
    explorerNode: {
      kind: "root",
      path: mount.mountPoint,
      name: mount.mountPoint.slice(1),
      title: mount.title,
      mountPoint: mount.mountPoint,
      mountTitle: mount.title,
      mountKind: mount.kind,
      readOnly: mount.readOnly,
      persistence: mount.persistence,
      description: mount.description,
      children: [],
    },
    metadata: null,
    children: [],
  };
}

function createFolderNode(mount: UploadExplorerMount, path: string): LocalUploadNode {
  return {
    explorerNode: {
      kind: "folder",
      path,
      name: getLeafSegment(path),
      title: getLeafSegment(path),
      mountPoint: mount.mountPoint,
      mountTitle: mount.title,
      mountKind: mount.kind,
      readOnly: mount.readOnly,
      persistence: mount.persistence,
      description: mount.description,
      children: [],
    },
    metadata: null,
    children: [],
  };
}

function createFileNode(
  mount: UploadExplorerMount,
  file: UploadFileRecord,
  orgId: string,
): LocalUploadNode {
  const contentType = resolveUploadContentType(file.fileKey, file.contentType);
  const previewUrl = buildUploadContentUrl(orgId, file.provider, file.fileKey);
  return {
    explorerNode: {
      kind: "file",
      path: `${mount.mountPoint}/${normalizeFileKey(file.fileKey)}`,
      name: getLeafSegment(file.fileKey),
      title: file.filename || getLeafSegment(file.fileKey),
      mountPoint: mount.mountPoint,
      mountTitle: mount.title,
      mountKind: mount.kind,
      readOnly: mount.readOnly,
      persistence: mount.persistence,
      description: mount.description,
      sizeBytes: file.sizeBytes,
      contentType,
      updatedAt: readUploadMtime(file),
    },
    metadata: {
      ...file.metadata,
      provider: file.provider,
      fileKey: file.fileKey,
      filename: file.filename,
      status: file.status,
      visibility: file.visibility ?? null,
      uploadId: file.uploadId ?? null,
      uploaderId: file.uploaderId ?? null,
      createdAt: file.createdAt ?? null,
      previewUrl,
    },
    children: [],
  };
}

function sortNodeChildren(node: LocalUploadNode): void {
  node.children.sort((left, right) => {
    const kindOrder =
      nodeKindOrder(left.explorerNode.kind) - nodeKindOrder(right.explorerNode.kind);
    return kindOrder || NODE_SORTER.compare(left.explorerNode.title, right.explorerNode.title);
  });

  for (const child of node.children) {
    sortNodeChildren(child);
  }

  node.explorerNode.children = node.children.map((child) => child.explorerNode);
}

function updateFolderCounts(node: LocalUploadNode): void {
  for (const child of node.children) {
    updateFolderCounts(child);
  }

  if (node.explorerNode.kind === "file") {
    return;
  }

  node.explorerNode.fileCount = node.children.filter(
    (child) => child.explorerNode.kind === "file",
  ).length;
  node.explorerNode.folderCount = node.children.filter(
    (child) => child.explorerNode.kind === "folder",
  ).length;
}

function createDetailFields(node: FilesExplorerTreeNode) {
  const fields = [
    { label: "Path", value: node.path },
    { label: "Type", value: node.kind === "root" ? "Mount root" : capitalize(node.kind) },
    { label: "Mount", value: node.mountTitle },
    { label: "Access", value: node.readOnly ? "Read-only" : "Writable" },
    { label: "Persistence", value: node.persistence },
  ];

  if (node.kind === "file") {
    if (typeof node.sizeBytes === "number") {
      fields.push({ label: "Size", value: formatBytesValue(node.sizeBytes) });
    }
    if (node.contentType) {
      fields.push({ label: "Content type", value: node.contentType });
    }
    if (node.updatedAt) {
      fields.push({ label: "Updated", value: formatDateValue(node.updatedAt) });
    }
  } else {
    fields.push(
      { label: "Folders", value: String(node.folderCount ?? 0) },
      { label: "Files", value: String(node.fileCount ?? 0) },
    );
  }

  return fields;
}

function buildUploadContentUrl(orgId: string, provider: string, fileKey: string): string {
  const params = new URLSearchParams({ provider, key: fileKey });
  return `/api/upload/${encodeURIComponent(orgId)}/files/by-key/content?${params}`;
}

function readUploadMtime(file: UploadFileRecord): string | Date | null {
  const fsMetadata = file.metadata?.__docsFs;
  if (fsMetadata && typeof fsMetadata === "object" && !Array.isArray(fsMetadata)) {
    const mtime = (fsMetadata as Record<string, unknown>).mtime;
    if (typeof mtime === "string" && !Number.isNaN(Date.parse(mtime))) {
      return mtime;
    }
  }

  return file.updatedAt ?? null;
}

function resolveUploadContentType(fileKey: string, contentType: string): string | null {
  const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (
    normalized &&
    normalized !== "application/octet-stream" &&
    normalized !== "binary/octet-stream"
  ) {
    return normalized;
  }

  if (/\.jpe?g$/i.test(fileKey)) {
    return "image/jpeg";
  }
  if (/\.png$/i.test(fileKey)) {
    return "image/png";
  }
  if (/\.gif$/i.test(fileKey)) {
    return "image/gif";
  }
  if (/\.webp$/i.test(fileKey)) {
    return "image/webp";
  }
  if (/\.svg$/i.test(fileKey)) {
    return "image/svg+xml";
  }
  if (/\.json$/i.test(fileKey)) {
    return "application/json";
  }
  if (/\.(md|mdx)$/i.test(fileKey)) {
    return "text/markdown";
  }
  if (/\.(txt|log)$/i.test(fileKey)) {
    return "text/plain";
  }
  if (/\.(ts|tsx)$/i.test(fileKey)) {
    return "text/typescript";
  }
  if (/\.js$/i.test(fileKey)) {
    return "text/javascript";
  }
  if (/\.html?$/i.test(fileKey)) {
    return "text/html";
  }
  if (/\.css$/i.test(fileKey)) {
    return "text/css";
  }
  if (/\.ya?ml$/i.test(fileKey)) {
    return "application/yaml";
  }
  if (/\.sh$/i.test(fileKey)) {
    return "text/x-shellscript";
  }
  return normalized || null;
}

function getParentFileKey(fileKey: string): string {
  const segments = normalizeFileKey(fileKey).split("/");
  return segments.length > 1 ? segments.slice(0, -1).join("/") : "";
}

function normalizeFileKey(fileKey: string): string {
  return fileKey.replace(/^\/+|\/+$/g, "");
}

function getLeafSegment(path: string): string {
  const segments = normalizeFileKey(path).split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function nodeKindOrder(kind: FilesExplorerTreeNode["kind"]): number {
  return kind === "folder" ? 0 : kind === "file" ? 1 : -1;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function formatBytesValue(value: number): string {
  if (value === 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const size = value / 1024 ** exponent;
  return `${size >= 10 || exponent === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[exponent]}`;
}

function formatDateValue(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
