import {
  createInvalidArgumentFileSystemError,
  createPathNotFoundFileSystemError,
  createReadOnlyFileSystemError,
  createUnsupportedOperationFileSystemError,
} from "../fs-errors";
import type { CpOptions, DirentEntry, FsStat, IFileSystem } from "../interface";
import {
  ensureFolderPath,
  normalizeMountPoint,
  normalizeRelativePath,
  resolvePath,
  stripTrailingSlash,
} from "../normalize-path";
import type { FileEntryDescriptor, FileSystemArtifact } from "../types";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const ENTRY_SORTER = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const UNKNOWN_MTIME = new Date(0);

export const createReadOnlyContentFileSystem = (
  mountPoint: string,
  artifacts: Record<string, FileSystemArtifact>,
): IFileSystem => ({
  async readFile(path) {
    const artifact = readContentText(mountPoint, artifacts, path);
    if (artifact === null) {
      throw createPathNotFoundFileSystemError("read", path);
    }
    return artifact;
  },
  async readFileBuffer(path) {
    const artifact = readContentBuffer(mountPoint, artifacts, path);
    if (artifact === null) {
      throw createPathNotFoundFileSystemError("read", path);
    }
    return artifact;
  },
  async writeFile(path) {
    throw createReadOnlyFileSystemError("write", path);
  },
  async appendFile(path) {
    throw createReadOnlyFileSystemError("append", path);
  },
  async exists(path) {
    return statContentEntry(mountPoint, artifacts, path, true) !== null;
  },
  async stat(path) {
    const stat = statContentEntry(mountPoint, artifacts, path, true);
    if (!stat) {
      throw createPathNotFoundFileSystemError("stat", path);
    }
    return stat;
  },
  async mkdir(path) {
    throw createReadOnlyFileSystemError("mkdir", path);
  },
  async readdir(path) {
    return listContentChildNames(mountPoint, artifacts, path);
  },
  async readdirWithFileTypes(path) {
    return listContentDirents(mountPoint, artifacts, path);
  },
  async rm(path) {
    throw createReadOnlyFileSystemError("rm", path);
  },
  async cp(src: string, _dest: string, options?: CpOptions) {
    const stat = await this.stat(src);
    if (stat.isDirectory && !options?.recursive) {
      throw createInvalidArgumentFileSystemError("copy", src);
    }
    throw createReadOnlyFileSystemError("copy", src);
  },
  async mv(src) {
    throw createReadOnlyFileSystemError("move", src);
  },
  resolvePath,
  getAllPaths() {
    return [mountPoint, ...Object.keys(artifacts).map((path) => `${mountPoint}/${path}`)];
  },
  async chmod(path) {
    throw createReadOnlyFileSystemError("chmod", path);
  },
  async symlink(_target: string, linkPath: string) {
    throw createReadOnlyFileSystemError("symlink", linkPath);
  },
  async link(_existingPath: string, newPath: string) {
    throw createReadOnlyFileSystemError("link", newPath);
  },
  async readlink(path) {
    throw createUnsupportedOperationFileSystemError("readlink", path);
  },
  async lstat(path) {
    return this.stat(path);
  },
  async realpath(path) {
    if (!(await this.exists(path))) {
      throw createPathNotFoundFileSystemError("realpath", path);
    }
    return stripTrailingSlash(path) || "/";
  },
  async utimes(path) {
    throw createReadOnlyFileSystemError("utimes", path);
  },
});

type MutableFolderEntry = FileEntryDescriptor & { kind: "folder"; children: FileEntryDescriptor[] };

const buildContentTree = (
  mountPoint: string,
  artifacts: Record<string, FileSystemArtifact>,
): FileEntryDescriptor[] => {
  const normalizedMountPoint = normalizeMountPoint(mountPoint);
  const folderMap = new Map<string, MutableFolderEntry>();
  const roots: FileEntryDescriptor[] = [];

  const ensureFolder = (path: string): MutableFolderEntry => {
    const folderPath = ensureFolderPath(path);
    const existing = folderMap.get(folderPath);
    if (existing) {
      return existing;
    }

    const folder: MutableFolderEntry = {
      kind: "folder",
      path: folderPath,
      title: getLeafSegment(stripTrailingSlash(folderPath)),
      children: [],
    };
    folderMap.set(folderPath, folder);

    const parentPath = getParentFolderPath(folderPath, normalizedMountPoint);
    if (!parentPath) {
      roots.push(folder);
      return folder;
    }

    ensureFolder(parentPath).children.push(folder);
    return folder;
  };

  for (const [rawRelativePath, artifact] of Object.entries(artifacts)) {
    const relativePath = normalizeRelativePath(rawRelativePath);
    if (!relativePath) {
      continue;
    }

    const segments = relativePath.split("/");
    if (segments.length > 1) {
      ensureFolder(`${normalizedMountPoint}/${segments.slice(0, -1).join("/")}`);
    }

    const absolutePath = normalizeMountPoint(`${normalizedMountPoint}/${relativePath}`);
    const descriptor: FileEntryDescriptor = {
      kind: "file",
      path: absolutePath,
      title: segments.at(-1),
      sizeBytes: getArtifactSize(artifact),
      contentType: guessContentType(absolutePath),
    };

    const parentPath = getParentFolderPath(absolutePath, normalizedMountPoint);
    if (!parentPath) {
      roots.push(descriptor);
      continue;
    }

    ensureFolder(parentPath).children.push(descriptor);
  }

  return roots.slice().sort(compareEntries).map(sortEntryChildren);
};

const listContentChildren = (
  mountPoint: string,
  artifacts: Record<string, FileSystemArtifact>,
  path: string,
): FileEntryDescriptor[] => {
  const tree = buildContentTree(mountPoint, artifacts);
  const normalizedMountPoint = normalizeMountPoint(mountPoint);
  const normalizedPath = normalizeDirectoryLookupPath(path);

  if (
    normalizedPath === normalizedMountPoint ||
    normalizedPath === ensureFolderPath(normalizedMountPoint)
  ) {
    return tree;
  }

  const entry = findContentEntry(mountPoint, artifacts, normalizedPath);
  return entry?.kind === "folder" ? (entry.children ?? []) : [];
};

const listContentChildNames = (
  mountPoint: string,
  artifacts: Record<string, FileSystemArtifact>,
  path: string,
): string[] => {
  return listContentChildren(mountPoint, artifacts, path).map((entry) =>
    getLeafSegment(stripTrailingSlash(entry.path)),
  );
};

const listContentDirents = (
  mountPoint: string,
  artifacts: Record<string, FileSystemArtifact>,
  path: string,
): DirentEntry[] => {
  return listContentChildren(mountPoint, artifacts, path).map((entry) => ({
    name: getLeafSegment(stripTrailingSlash(entry.path)),
    isFile: entry.kind === "file",
    isDirectory: entry.kind === "folder",
    isSymbolicLink: false,
  }));
};

const findContentEntry = (
  mountPoint: string,
  artifacts: Record<string, FileSystemArtifact>,
  path: string,
): FileEntryDescriptor | null => {
  const tree = buildContentTree(mountPoint, artifacts);
  return findEntryInTree(tree, path);
};

const statContentEntry = (
  mountPoint: string,
  artifacts: Record<string, FileSystemArtifact>,
  path: string,
  readOnly: boolean,
): FsStat | null => {
  const normalizedMountPoint = normalizeMountPoint(mountPoint);
  const normalizedPath = normalizeDirectoryLookupPath(path);
  if (
    normalizedPath === normalizedMountPoint ||
    normalizedPath === ensureFolderPath(normalizedMountPoint)
  ) {
    return {
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
      mode: readOnly ? 0o555 : 0o755,
      size: 0,
      mtime: UNKNOWN_MTIME,
    };
  }

  const entry = findContentEntry(mountPoint, artifacts, normalizedPath);
  if (!entry) {
    return null;
  }

  return {
    isFile: entry.kind === "file",
    isDirectory: entry.kind === "folder",
    isSymbolicLink: false,
    mode: entry.kind === "folder" ? (readOnly ? 0o555 : 0o755) : readOnly ? 0o444 : 0o644,
    size: entry.kind === "file" ? (entry.sizeBytes ?? 0) : 0,
    mtime: UNKNOWN_MTIME,
  };
};

const readContentArtifact = (
  mountPoint: string,
  artifacts: Record<string, FileSystemArtifact>,
  path: string,
): FileSystemArtifact | null => {
  const relativePath = toRelativeArtifactPath(mountPoint, path);
  if (!relativePath) {
    return null;
  }

  return artifacts[relativePath] ?? null;
};

const readContentText = (
  mountPoint: string,
  artifacts: Record<string, FileSystemArtifact>,
  path: string,
): string | null => {
  const artifact = readContentArtifact(mountPoint, artifacts, path);
  if (artifact === null) {
    return null;
  }

  if (typeof artifact === "string") {
    return artifact;
  }

  return TEXT_DECODER.decode(artifact);
};

const readContentBuffer = (
  mountPoint: string,
  artifacts: Record<string, FileSystemArtifact>,
  path: string,
): Uint8Array | null => {
  const artifact = readContentArtifact(mountPoint, artifacts, path);
  if (artifact === null) {
    return null;
  }

  return typeof artifact === "string" ? TEXT_ENCODER.encode(artifact) : artifact;
};

const toRelativeArtifactPath = (mountPoint: string, path: string): string | null => {
  const normalizedMountPoint = normalizeMountPoint(mountPoint);
  const normalizedPath = normalizeMountPoint(path);
  if (!normalizedPath.startsWith(`${normalizedMountPoint}/`)) {
    return null;
  }

  const relativePath = normalizedPath.slice(normalizedMountPoint.length + 1);
  return normalizeRelativePath(relativePath);
};

const findEntryInTree = (
  entries: FileEntryDescriptor[],
  path: string,
): FileEntryDescriptor | null => {
  const normalizedPath = normalizeDirectoryLookupPath(path);
  const comparablePath = stripTrailingSlash(normalizedPath);

  for (const entry of entries) {
    if (stripTrailingSlash(entry.path) === comparablePath) {
      return entry;
    }

    if (entry.kind === "folder" && entry.children?.length) {
      const nested = findEntryInTree(entry.children, normalizedPath);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
};

const normalizeDirectoryLookupPath = (path: string): string => {
  if (path.endsWith("/")) {
    return ensureFolderPath(path);
  }

  return normalizeMountPoint(path);
};

const compareEntries = (left: FileEntryDescriptor, right: FileEntryDescriptor): number => {
  const leftRank = left.kind === "folder" ? 0 : 1;
  const rightRank = right.kind === "folder" ? 0 : 1;
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  return ENTRY_SORTER.compare(left.title ?? left.path, right.title ?? right.path);
};

const sortEntryChildren = (entry: FileEntryDescriptor): FileEntryDescriptor => ({
  ...entry,
  children: entry.children?.slice().sort(compareEntries).map(sortEntryChildren),
});

const getParentFolderPath = (path: string, mountPoint: string): string | null => {
  const normalizedPath = stripTrailingSlash(path);
  if (normalizedPath === mountPoint) {
    return null;
  }

  const segments = normalizedPath.split("/").filter(Boolean);
  if (segments.length <= 1) {
    return null;
  }

  const parentPath = `/${segments.slice(0, -1).join("/")}`;
  return parentPath === mountPoint ? null : ensureFolderPath(parentPath);
};

const getLeafSegment = (path: string): string => {
  return path.split("/").filter(Boolean).at(-1) ?? path;
};

const getArtifactSize = (artifact: FileSystemArtifact): number => {
  if (typeof artifact === "string") {
    return TEXT_ENCODER.encode(artifact).byteLength;
  }

  return artifact.byteLength;
};

const guessContentType = (path: string): string | null => {
  if (path.endsWith(".md")) {
    return "text/markdown";
  }
  if (path.endsWith(".mdx")) {
    return "text/markdown";
  }
  if (path.endsWith(".txt") || path.endsWith(".gitkeep")) {
    return "text/plain";
  }
  if (path.endsWith(".json")) {
    return "application/json";
  }
  if (path.endsWith(".ts")) {
    return "text/typescript";
  }
  if (path.endsWith(".sh")) {
    return "text/x-shellscript";
  }

  return null;
};
