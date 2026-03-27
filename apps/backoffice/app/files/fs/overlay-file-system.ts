import { createUnsupportedOperationFileSystemError } from "../fs-errors";
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
    } catch {
      return null;
    }
  };

  const safeWriteStat = async (path: string): Promise<FsStat | null> => {
    try {
      return await writeLayer.stat(path);
    } catch {
      return null;
    }
  };

  const safeReadDirents = async (path: string): Promise<DirentEntry[]> => {
    if (readLayer.readdirWithFileTypes) {
      try {
        return await readLayer.readdirWithFileTypes(path);
      } catch {
        return [];
      }
    }

    if (readLayer.readdir) {
      try {
        const names = await readLayer.readdir(path);
        return Promise.all(
          names.map(async (name) => {
            const stat = await readLayer.stat?.(resolvePath(path, name));
            return {
              name,
              isFile: stat?.isFile ?? false,
              isDirectory: stat?.isDirectory ?? false,
              isSymbolicLink: stat?.isSymbolicLink ?? false,
            } satisfies DirentEntry;
          }),
        );
      } catch {
        return [];
      }
    }

    return [];
  };

  const safeWriteDirents = async (path: string): Promise<DirentEntry[]> => {
    try {
      if (writeLayer.readdirWithFileTypes) {
        return await writeLayer.readdirWithFileTypes(path);
      }

      const names = await writeLayer.readdir(path);
      return Promise.all(
        names.map(async (name) => {
          const stat = await writeLayer.stat(resolvePath(path, name));
          return {
            name,
            isFile: stat.isFile,
            isDirectory: stat.isDirectory,
            isSymbolicLink: stat.isSymbolicLink,
          } satisfies DirentEntry;
        }),
      );
    } catch {
      return [];
    }
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
    const writeDirents = await safeWriteDirents(normalizedPath);
    const readDirents = await safeReadDirents(normalizedPath);
    const merged = new Map<string, DirentEntry>();

    for (const entry of readDirents) {
      merged.set(entry.name, entry);
    }

    for (const entry of writeDirents) {
      merged.set(entry.name, entry);
    }

    if (merged.size === 0) {
      const exists = await safeWriteExists(normalizedPath);
      const stat = exists
        ? await safeWriteStat(normalizedPath)
        : await safeReadStat(normalizedPath);
      if (!stat?.isDirectory) {
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
    if (readStat?.isFile) {
      return true;
    }

    if (!readStat?.isDirectory) {
      return false;
    }

    const queue = [normalizeDirectoryPath(path)];

    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) {
        continue;
      }

      const entries = await safeReadDirents(next);

      for (const entry of entries) {
        if (entry.isFile) {
          return true;
        }

        if (entry.isDirectory) {
          queue.push(normalizeDirectoryPath(resolvePath(next, entry.name)));
        }
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
      if (await safeWriteExists(path)) {
        return writeLayer.readFile(path, options);
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
      if (await safeWriteExists(path)) {
        return writeLayer.readFileBuffer(path);
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
      if (await safeWriteExists(path)) {
        if (writeLayer.readFileStream) {
          return writeLayer.readFileStream(path);
        }

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
      const writeExists = await safeWriteExists(path);
      const readBacked = await hasReadLayerPathAtOrBelow(path);

      if (!writeExists) {
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
