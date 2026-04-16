import { FileSystemError, createUnsupportedOperationFileSystemError } from "../fs-errors";
import type { DirentEntry, FsStat } from "../interface";
import { normalizeMountedFileSystem } from "../mounted-file-system";
import type { FileEntryDescriptor, MountedFileSystem } from "../types";

const TEXT_ENCODER = new TextEncoder();
const UNKNOWN_MTIME = new Date(0);

type OverlayWriteLayer = Pick<
  MountedFileSystem,
  | "describeEntry"
  | "exists"
  | "stat"
  | "readdir"
  | "readdirWithFileTypes"
  | "readFile"
  | "readFileBuffer"
  | "readFileStream"
  | "writeFile"
  | "mkdir"
  | "rm"
  | "chmod"
  | "utimes"
  | "getAllPaths"
> & {
  exists: NonNullable<MountedFileSystem["exists"]>;
  stat: NonNullable<MountedFileSystem["stat"]>;
  readdir: NonNullable<MountedFileSystem["readdir"]>;
  readFile: NonNullable<MountedFileSystem["readFile"]>;
  readFileBuffer: NonNullable<MountedFileSystem["readFileBuffer"]>;
  writeFile: NonNullable<MountedFileSystem["writeFile"]>;
  mkdir: NonNullable<MountedFileSystem["mkdir"]>;
  rm: NonNullable<MountedFileSystem["rm"]>;
  chmod: NonNullable<MountedFileSystem["chmod"]>;
  utimes: NonNullable<MountedFileSystem["utimes"]>;
  getAllPaths: NonNullable<MountedFileSystem["getAllPaths"]>;
};

export type OverlayMountedFileSystemOptions = {
  mountPoint: string;
  readLayer: MountedFileSystem;
  writeLayer: OverlayWriteLayer;
};

export const createOverlayMountedFileSystem = (
  options: OverlayMountedFileSystemOptions,
): MountedFileSystem => {
  const { mountPoint, readLayer, writeLayer } = options;

  const safeReadExists = async (path: string): Promise<boolean> => {
    if (readLayer.exists) {
      try {
        return await readLayer.exists(path);
      } catch {
        return false;
      }
    }

    if (readLayer.stat) {
      try {
        await readLayer.stat(path);
        return true;
      } catch {
        return false;
      }
    }

    return false;
  };

  const safeWriteExists = async (path: string): Promise<boolean> => {
    try {
      return await writeLayer.exists(path);
    } catch {
      return false;
    }
  };

  const safeReadStat = async (path: string): Promise<FsStat | null> => {
    if (!readLayer.stat) {
      return null;
    }

    try {
      return await readLayer.stat(path);
    } catch (error) {
      if (isPathNotFoundError(error)) {
        return null;
      }

      throw error;
    }
  };

  const safeWriteStat = async (path: string): Promise<FsStat | null> => {
    try {
      return await writeLayer.stat(path);
    } catch (error) {
      if (isPathNotFoundError(error)) {
        return null;
      }

      throw error;
    }
  };

  const safeReadDirents = async (path: string): Promise<DirentEntry[]> => {
    if (readLayer.readdirWithFileTypes) {
      try {
        return await readLayer.readdirWithFileTypes(path);
      } catch (error) {
        if (isPathNotFoundError(error)) {
          return [];
        }

        throw error;
      }
    }

    if (readLayer.readdir) {
      let names: string[];
      try {
        names = await readLayer.readdir(path);
      } catch (error) {
        if (isPathNotFoundError(error)) {
          return [];
        }

        throw error;
      }

      const entries = await Promise.all(
        names.map(async (name) => {
          try {
            const stat = await readLayer.stat?.(resolvePath(path, name));
            return {
              name,
              isFile: stat?.isFile ?? false,
              isDirectory: stat?.isDirectory ?? false,
              isSymbolicLink: stat?.isSymbolicLink ?? false,
            } satisfies DirentEntry;
          } catch (error) {
            if (isPathNotFoundError(error)) {
              return null;
            }

            throw error;
          }
        }),
      );

      return entries.filter((entry): entry is DirentEntry => entry !== null);
    }

    return [];
  };

  const safeWriteDirents = async (path: string): Promise<DirentEntry[]> => {
    if (writeLayer.readdirWithFileTypes) {
      try {
        return await writeLayer.readdirWithFileTypes(path);
      } catch (error) {
        if (isPathNotFoundError(error)) {
          return [];
        }

        throw error;
      }
    }

    let names: string[];
    try {
      names = await writeLayer.readdir(path);
    } catch (error) {
      if (isPathNotFoundError(error)) {
        return [];
      }

      throw error;
    }

    const entries = await Promise.all(
      names.map(async (name) => {
        try {
          const stat = await writeLayer.stat(resolvePath(path, name));
          return {
            name,
            isFile: stat.isFile,
            isDirectory: stat.isDirectory,
            isSymbolicLink: stat.isSymbolicLink,
          } satisfies DirentEntry;
        } catch (error) {
          if (isPathNotFoundError(error)) {
            return null;
          }

          throw error;
        }
      }),
    );

    return entries.filter((entry): entry is DirentEntry => entry !== null);
  };

  const describeOverlayEntry = async (path: string): Promise<FileEntryDescriptor | null> => {
    const writeStat = await safeWriteStat(path);
    if (writeStat) {
      if (writeLayer.describeEntry) {
        try {
          const writeDescriptor = await writeLayer.describeEntry(path, writeStat);
          if (writeDescriptor) {
            return writeDescriptor;
          }
        } catch {
          // ignore and fall back to the read layer below
        }
      }

      if (readLayer.describeEntry) {
        try {
          const readDescriptor = await readLayer.describeEntry(path, writeStat);
          if (readDescriptor) {
            return readDescriptor;
          }
        } catch {
          // ignore and fall back to stat-derived descriptor below
        }
      }

      return null;
    }

    if (!readLayer.describeEntry) {
      return null;
    }

    try {
      return await readLayer.describeEntry(path);
    } catch {
      return null;
    }
  };

  const readOverlayDirents = async (path: string): Promise<DirentEntry[]> => {
    const normalizedPath = normalizeDirectoryPath(path);
    const overlayPath = stripTrailingSlash(normalizedPath);
    const writeDirents = await safeWriteDirents(normalizedPath);
    const readDirents = await safeReadDirents(normalizedPath);
    const merged = new Map<string, DirentEntry>();

    for (const entry of readDirents) {
      merged.set(entry.name, entry);
    }

    for (const entry of writeDirents) {
      merged.set(entry.name, entry);
    }

    const writeStat = await safeWriteStat(overlayPath);
    if (writeStat?.isFile) {
      merged.clear();
    } else {
      for (const entry of writeDirents) {
        if (!entry.isFile) {
          continue;
        }

        const shadowedPrefix = `${entry.name}/`;
        for (const name of Array.from(merged.keys())) {
          if (name.startsWith(shadowedPrefix)) {
            merged.delete(name);
          }
        }
      }
    }

    if (merged.size === 0) {
      const readStat = writeStat ? null : await safeReadStat(overlayPath);
      if (!writeStat?.isDirectory && !readStat?.isDirectory) {
        throw new Error("Path not found.");
      }
    }

    return Array.from(merged.values()).sort((left, right) => left.name.localeCompare(right.name));
  };

  const assertCanWriteFile = async (path: string): Promise<void> => {
    const readStat = await safeReadStat(path);
    if (readStat?.isDirectory) {
      throw new Error(`Cannot overwrite read-layer directory '${path}' with a file.`);
    }

    await ensureParentDirectory(path);
  };

  const assertCanCreateDirectory = async (path: string): Promise<void> => {
    const readStat = await safeReadStat(path);
    if (readStat?.isFile) {
      throw new Error(
        `Cannot create directory '${path}' because the read layer contains a file there.`,
      );
    }
  };

  const ensureParentDirectory = async (path: string): Promise<void> => {
    const parent = toParentPath(path);
    if (!parent) {
      return;
    }

    const writeParentExists = await safeWriteExists(parent);
    if (writeParentExists) {
      return;
    }

    const readParent = await safeReadStat(parent);
    if (readParent?.isFile) {
      throw new Error(`Cannot create '${path}' because '${parent}' is a file in the read layer.`);
    }

    await writeLayer.mkdir(parent, { recursive: true });
  };

  const hasReadLayerPathAtOrBelow = async (path: string): Promise<boolean> => {
    const readStat = await safeReadStat(path);
    if (readStat) {
      return true;
    }

    const queue = [normalizeDirectoryPath(path)];

    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) {
        continue;
      }

      const entries = await safeReadDirents(next);
      if (entries.length > 0) {
        return true;
      }
    }

    return false;
  };

  return normalizeMountedFileSystem({
    async describeEntry(path) {
      return describeOverlayEntry(path);
    },
    async exists(path) {
      return (await safeWriteExists(path)) || (await safeReadExists(path));
    },
    async stat(path) {
      const writeStat = await safeWriteStat(path);
      if (writeStat) {
        return writeStat;
      }

      const readStat = await safeReadStat(path);
      if (readStat) {
        return readStat;
      }

      if (stripTrailingSlash(path) === stripTrailingSlash(mountPoint)) {
        return createDirectoryStat();
      }

      throw new Error("Path not found.");
    },
    async readdir(path) {
      return (await readOverlayDirents(path)).map((entry) => entry.name);
    },
    async readdirWithFileTypes(path) {
      return readOverlayDirents(path);
    },
    async readFile(path, options) {
      try {
        return await writeLayer.readFile(path, options);
      } catch (error) {
        if (!isPathNotFoundError(error)) {
          throw error;
        }
      }

      if (readLayer.readFile) {
        return readLayer.readFile(path, options);
      }

      if (readLayer.readFileBuffer) {
        return new TextDecoder().decode(await readLayer.readFileBuffer(path));
      }

      throw new Error("This mounted filesystem does not support reading files.");
    },
    async readFileBuffer(path) {
      try {
        return await writeLayer.readFileBuffer(path);
      } catch (error) {
        if (!isPathNotFoundError(error)) {
          throw error;
        }

        const writeStat = await safeWriteStat(path);
        if (writeStat?.isDirectory) {
          throw new Error("This mounted filesystem does not support reading files.");
        }
      }

      if (readLayer.readFileBuffer) {
        return readLayer.readFileBuffer(path);
      }

      if (readLayer.readFile) {
        return TEXT_ENCODER.encode(await readLayer.readFile(path));
      }

      throw new Error("This mounted filesystem does not support reading files.");
    },
    async readFileStream(path) {
      if (writeLayer.readFileStream) {
        try {
          return await writeLayer.readFileStream(path);
        } catch (error) {
          if (!isPathNotFoundError(error)) {
            throw error;
          }

          const writeStat = await safeWriteStat(path);
          if (writeStat?.isDirectory) {
            throw createUnsupportedOperationFileSystemError("read stream", path);
          }
        }
      } else if (await safeWriteStat(path)) {
        throw createUnsupportedOperationFileSystemError("read stream", path);
      }

      if (readLayer.readFileStream) {
        return readLayer.readFileStream(path);
      }

      throw createUnsupportedOperationFileSystemError("read stream", path);
    },
    async writeFile(path, content, options) {
      await assertCanWriteFile(path);
      await writeLayer.writeFile(path, content, options);
    },
    async mkdir(path, options) {
      await assertCanCreateDirectory(path);
      await writeLayer.mkdir(path, options);
    },
    async rm(path, options) {
      const writeStat = await safeWriteStat(path);
      const readBacked = await hasReadLayerPathAtOrBelow(path);

      if (!writeStat) {
        if (readBacked) {
          throw new Error(
            `Cannot delete '${path}' because it is backed by the starter read layer. Tombstones are not supported yet.`,
          );
        }

        if (options?.force) {
          return;
        }
        throw new Error("Path not found.");
      }

      await writeLayer.rm(path, options);
    },
    async chmod(path, mode) {
      await writeLayer.chmod(path, mode);
    },
    async utimes(path, atime, mtime) {
      await writeLayer.utimes(path, atime, mtime);
    },
    resolvePath(base, path) {
      return resolvePath(base, path);
    },
    getAllPaths() {
      const paths = new Set<string>([mountPoint]);

      for (const path of readLayer.getAllPaths()) {
        paths.add(path);
      }

      for (const path of writeLayer.getAllPaths()) {
        paths.add(path);
      }

      return Array.from(paths).sort();
    },
  });
};

const isPathNotFoundError = (error: unknown): boolean => {
  if (error instanceof FileSystemError) {
    return error.code === "ENOENT";
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return error.message === "Path not found." || error.message === "File not found.";
};

const createDirectoryStat = (): FsStat => ({
  isFile: false,
  isDirectory: true,
  isSymbolicLink: false,
  mode: 0o755,
  size: 0,
  mtime: UNKNOWN_MTIME,
});

const resolvePath = (base: string, path: string): string => {
  if (path.startsWith("/")) {
    return normalizeAbsolutePath(path);
  }

  const baseSegments = normalizeAbsolutePath(base).split("/").filter(Boolean);
  const pathSegments = path.replaceAll("\\", "/").split("/");
  const resolved = [...baseSegments];

  for (const segment of pathSegments) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }

  return `/${resolved.join("/")}`;
};

const normalizeAbsolutePath = (value: string): string => {
  const normalized = value.trim().replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  return `/${segments.join("/")}`;
};

const normalizeDirectoryPath = (value: string): string =>
  ensureFolderPath(normalizeAbsolutePath(value));

const stripTrailingSlash = (value: string): string => {
  if (value === "/") {
    return value;
  }

  return value.replace(/\/+$/, "");
};

const ensureFolderPath = (value: string): string => {
  if (value === "/") {
    return value;
  }

  return value.endsWith("/") ? value : `${value}/`;
};

const toParentPath = (path: string): string | null => {
  const normalized = normalizeAbsolutePath(path);
  if (normalized === "/") {
    return null;
  }

  const segments = normalized.split("/").filter(Boolean);
  if (segments.length <= 1) {
    return "/";
  }

  return `/${segments.slice(0, -1).join("/")}`;
};
