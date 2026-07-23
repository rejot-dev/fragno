import { compareFileEntries } from "./entry-order";
import {
  type FilesExplorerNode,
  type FilesExplorerTreeNode,
  type FilesNodeCapabilities,
  type FilesNodeDetail,
} from "./explorer-types";
import type { DirentEntry, FsStat } from "./interface";
import type { MasterFileSystem } from "./master-file-system";
import { ensureFolderPath, normalizeAbsolutePath, stripTrailingSlash } from "./normalize-path";
import type { FileEntryDescriptor, ResolvedFileMount } from "./types";

const TEXT_ENCODER = new TextEncoder();
const UNKNOWN_MTIME = new Date(0);

type ResolvedFilesTarget = {
  master: MasterFileSystem;
  mount: ResolvedFileMount;
  normalizedPath: string;
  isRoot: boolean;
  isFolderPath: boolean;
};

export async function listFilesTree(master: MasterFileSystem): Promise<FilesExplorerTreeNode[]> {
  return Promise.all(
    master.mounts.map(async (mount) => {
      const children = await describeDirectoryEntries(master, mount, mount.mountPoint);

      return {
        ...createRootNode(mount),
        children: children.map((entry) => createTreeNode(mount, entry)),
      } satisfies FilesExplorerTreeNode;
    }),
  );
}

export async function listFilesChildren(
  master: MasterFileSystem,
  path: string,
): Promise<FilesExplorerNode[]> {
  const target = await resolveFilesTarget(master, path);
  if (!target || (!target.isRoot && !target.isFolderPath)) {
    return [];
  }

  const children = await describeDirectoryEntries(
    target.master,
    target.mount,
    ensureFolderPath(target.normalizedPath),
  );
  return children.map((entry) => createExplorerNode(target.mount, entry));
}

export async function getFilesNodeDetail(
  master: MasterFileSystem,
  path: string,
): Promise<FilesNodeDetail | null> {
  const target = await resolveFilesTarget(master, path);
  if (!target) {
    return null;
  }

  if (target.isRoot) {
    const children = await describeDirectoryEntries(
      target.master,
      target.mount,
      target.mount.mountPoint,
    );
    return createRootDetail(target.mount, children);
  }

  const entry = await describePath(target.master, target.mount, target.normalizedPath);
  if (!entry) {
    return null;
  }

  const node = createExplorerNode(target.mount, entry);
  const children =
    entry.kind === "folder"
      ? await describeDirectoryEntries(target.master, target.mount, entry.path)
      : [];
  const textContent =
    entry.kind === "file" && shouldReadText(node) ? await readTextContent(target) : null;

  return {
    node: {
      ...node,
      fileCount: entry.kind === "folder" ? countChildren(children, "file") : node.fileCount,
      folderCount: entry.kind === "folder" ? countChildren(children, "folder") : node.folderCount,
    },
    description: target.mount.description ?? `${capitalize(entry.kind)} in ${target.mount.title}.`,
    fields: createDetailFields(target.mount, node, children),
    metadata: entry.metadata ?? null,
    textContent,
    capabilities: createCapabilities(target.mount, node.kind),
  };
}

export async function resolveFilesTarget(
  master: MasterFileSystem,
  path: string,
): Promise<ResolvedFilesTarget | null> {
  const normalizedPath = normalizeExplorerPath(path);
  const pathWithoutTrailingSlash = stripTrailingSlash(normalizedPath);
  const mount = master.getMountForPath(pathWithoutTrailingSlash);

  if (!mount) {
    return null;
  }

  return {
    master,
    mount,
    normalizedPath,
    isRoot: pathWithoutTrailingSlash === mount.mountPoint,
    isFolderPath: normalizedPath.endsWith("/"),
  };
}

const describeDirectoryEntries = async (
  master: MasterFileSystem,
  mount: ResolvedFileMount,
  path: string,
): Promise<FileEntryDescriptor[]> => {
  try {
    const entries = await master.readdirWithFileTypes(path);
    const described = await Promise.all(
      entries.map((entry) => describeDirentEntry(master, mount, path, entry)),
    );
    return described.filter(isDefined).sort(compareFileEntries);
  } catch {
    return [];
  }
};

const describeDirentEntry = async (
  master: MasterFileSystem,
  mount: ResolvedFileMount,
  parentPath: string,
  entry: DirentEntry,
): Promise<FileEntryDescriptor | null> => {
  const childPath = entry.isDirectory
    ? ensureFolderPath(joinChildPath(parentPath, entry.name))
    : joinChildPath(parentPath, entry.name);
  const syntheticStat = createSyntheticStat(entry);
  return describePath(master, mount, childPath, syntheticStat);
};

const describePath = async (
  master: MasterFileSystem,
  mount: ResolvedFileMount,
  path: string,
  fallbackStat?: FsStat,
): Promise<FileEntryDescriptor | null> => {
  const stat = fallbackStat ?? (await readStat(master, path));
  return stat ? createDescriptorFromStat(path, stat) : null;
};

const readStat = async (master: MasterFileSystem, path: string): Promise<FsStat | null> => {
  try {
    return await master.stat(path);
  } catch {
    return null;
  }
};

const createRootNode = (mount: ResolvedFileMount): FilesExplorerNode => ({
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
});

const createTreeNode = (
  mount: ResolvedFileMount,
  entry: FileEntryDescriptor,
): FilesExplorerTreeNode => {
  const node = createExplorerNode(mount, entry);

  return {
    ...node,
    children: entry.children?.map((child) => createTreeNode(mount, child)),
  };
};

const createExplorerNode = (
  mount: ResolvedFileMount,
  entry: FileEntryDescriptor,
): FilesExplorerNode => {
  const title = entry.title ?? getLeafSegment(stripTrailingSlash(entry.path));
  return {
    kind: entry.kind,
    path: entry.path,
    name: getLeafSegment(stripTrailingSlash(entry.path)),
    title,
    mountPoint: mount.mountPoint,
    mountTitle: mount.title,
    mountKind: mount.kind,
    readOnly: mount.readOnly,
    persistence: mount.persistence,
    description: mount.description,
    sizeBytes: entry.sizeBytes ?? null,
    contentType: entry.contentType ?? null,
    updatedAt: entry.updatedAt ?? null,
    fileCount: entry.kind === "folder" ? countChildren(entry.children ?? [], "file") : undefined,
    folderCount:
      entry.kind === "folder" ? countChildren(entry.children ?? [], "folder") : undefined,
  };
};

const createRootDetail = (
  mount: ResolvedFileMount,
  children: FileEntryDescriptor[],
): FilesNodeDetail => ({
  node: {
    ...createRootNode(mount),
    fileCount: countChildren(children, "file"),
    folderCount: countChildren(children, "folder"),
  },
  description: mount.description ?? `Top-level mount at ${mount.mountPoint}.`,
  fields: [
    { label: "Path", value: mount.mountPoint },
    { label: "Type", value: "Mount root" },
    { label: "Kind", value: mount.kind },
    { label: "Access", value: mount.readOnly ? "Read-only" : "Writable" },
    { label: "Persistence", value: mount.persistence },
    { label: "Folders", value: String(countChildren(children, "folder")) },
    { label: "Files", value: String(countChildren(children, "file")) },
  ],
  metadata: null,
  textContent: null,
  capabilities: createCapabilities(mount, "root"),
});

const createDetailFields = (
  mount: ResolvedFileMount,
  node: FilesExplorerNode,
  children: FileEntryDescriptor[],
) => {
  const fields = [
    { label: "Path", value: node.path },
    { label: "Type", value: capitalize(node.kind) },
    { label: "Mount", value: mount.title },
    { label: "Access", value: node.readOnly ? "Read-only" : "Writable" },
    { label: "Persistence", value: node.persistence },
  ];

  if (node.kind !== "root") {
    if (typeof node.sizeBytes === "number") {
      fields.push({ label: "Size", value: formatBytesValue(node.sizeBytes) });
    }
    if (node.contentType) {
      fields.push({ label: "Content type", value: node.contentType });
    }
    if (node.updatedAt) {
      fields.push({ label: "Updated", value: formatDateValue(node.updatedAt) });
    }
  }

  if (node.kind === "folder" || node.kind === "root") {
    fields.push(
      { label: "Folders", value: String(countChildren(children, "folder")) },
      { label: "Files", value: String(countChildren(children, "file")) },
    );
  }

  return fields;
};

const createCapabilities = (
  mount: ResolvedFileMount,
  nodeKind: FilesExplorerNode["kind"],
): FilesNodeCapabilities => ({
  canCreateFolder: !mount.readOnly && nodeKind !== "file",
  canWriteText: !mount.readOnly && nodeKind === "file",
  canDelete: !mount.readOnly && nodeKind !== "root",
});

const readTextContent = async (target: ResolvedFilesTarget): Promise<string | null> => {
  try {
    return await target.master.readFile(target.normalizedPath, { encoding: "utf-8" });
  } catch {
    return null;
  }
};

const countChildren = (
  entries: FileEntryDescriptor[],
  kind: FileEntryDescriptor["kind"],
): number => {
  return entries.filter((entry) => entry.kind === kind).length;
};

const shouldReadText = (node: FilesExplorerNode): boolean => {
  if (node.kind !== "file") {
    return false;
  }

  const contentType = node.contentType?.toLowerCase() ?? "";
  if (!contentType) {
    return /\.(md|mdx|txt|json|js|jsx|ts|tsx|css|html|xml|yml|yaml|toml|ini|sh)$/i.test(node.path);
  }

  return (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("javascript") ||
    contentType.includes("xml") ||
    contentType.includes("yaml")
  );
};

const createSyntheticStat = (entry: DirentEntry): FsStat => ({
  isFile: entry.isFile,
  isDirectory: entry.isDirectory,
  isSymbolicLink: entry.isSymbolicLink,
  mode: entry.isDirectory ? 0o755 : 0o644,
  size: 0,
  mtime: UNKNOWN_MTIME,
});

const createDescriptorFromStat = (path: string, stat: FsStat): FileEntryDescriptor => ({
  kind: stat.isDirectory ? "folder" : "file",
  path,
  title: getLeafSegment(stripTrailingSlash(path)),
  sizeBytes: stat.isFile ? stat.size : undefined,
  updatedAt: stat.mtime,
});

const joinChildPath = (parentPath: string, childName: string): string => {
  const normalizedParent = stripTrailingSlash(parentPath);
  return `${normalizedParent}/${childName}`;
};

const isDefined = <T>(value: T | null | undefined): value is T =>
  value !== null && value !== undefined;

const normalizeExplorerPath = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Explorer path cannot be empty.");
  }

  const normalized = normalizeAbsolutePath(trimmed);
  return trimmed.length > 1 && trimmed.endsWith("/") ? ensureFolderPath(normalized) : normalized;
};

const getLeafSegment = (value: string): string => {
  const segments = value.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? value;
};

const capitalize = (value: string): string => `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;

const formatBytesValue = (value: number): string => {
  if (value === 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const size = value / 1024 ** exponent;
  return `${size >= 10 || exponent === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[exponent]}`;
};

const formatDateValue = (value: string | Date): string => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};

export const getTextArtifactSize = (value: string): number => TEXT_ENCODER.encode(value).byteLength;
