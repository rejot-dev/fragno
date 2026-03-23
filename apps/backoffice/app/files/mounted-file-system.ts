import {
  createReadOnlyFileSystemError,
  createUnsupportedOperationFileSystemError,
} from "./fs-errors";
import type {
  BufferEncoding,
  CpOptions,
  DirentEntry,
  FileContent,
  FsStat,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  WriteFileOptions,
} from "./interface";
import type {
  FileEntryDescriptor,
  MountedFileSystem,
  MountedFileSystemCapabilities,
  MountedFileSystemInput,
} from "./types";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const UNKNOWN_MTIME = new Date(0);

export type NormalizeMountedFileSystemOptions = {
  readOnly?: boolean;
};

export const normalizeMountedFileSystem = (
  input: MountedFileSystemInput,
  options: NormalizeMountedFileSystemOptions = {},
): MountedFileSystem => {
  const readOnly = options.readOnly ?? false;
  const fs = {} as MountedFileSystem;
  const explicitCapabilities = input.capabilities ?? {};

  const getCapability = (key: keyof MountedFileSystemCapabilities): boolean => {
    if (readOnly) {
      return false;
    }

    const explicit = explicitCapabilities[key];
    if (typeof explicit === "boolean") {
      return explicit;
    }

    return typeof input[key] === "function";
  };

  const throwReadOnly = (operation?: string, path?: string): never => {
    if (operation && path) {
      throw createReadOnlyFileSystemError(operation, path);
    }

    throw new Error("This mounted filesystem is read-only.");
  };

  const throwUnsupported = (message: string, operation?: string, path?: string): never => {
    if (readOnly) {
      return throwReadOnly(operation, path);
    }

    if (operation && path) {
      throw createUnsupportedOperationFileSystemError(operation, path);
    }

    throw new Error(message);
  };

  const call = <TArgs extends unknown[], TResult>(
    method: ((...args: TArgs) => TResult) | undefined,
    ...args: TArgs
  ): TResult => {
    if (!method) {
      throw new Error("Attempted to call a missing mounted filesystem method.");
    }

    return method.apply(fs, args);
  };

  const describeEntry = input.describeEntry
    ? async (path: string, stat?: FsStat | null): Promise<FileEntryDescriptor | null> =>
        await call(input.describeEntry, path, stat)
    : undefined;

  const statFromDescriptor = (descriptor: FileEntryDescriptor): FsStat => ({
    isFile: descriptor.kind === "file",
    isDirectory: descriptor.kind === "folder",
    isSymbolicLink: false,
    mode: descriptor.kind === "folder" ? (readOnly ? 0o555 : 0o755) : readOnly ? 0o444 : 0o644,
    size: descriptor.kind === "file" ? (descriptor.sizeBytes ?? 0) : 0,
    mtime: descriptor.updatedAt ? new Date(descriptor.updatedAt) : UNKNOWN_MTIME,
  });

  fs.capabilities = {
    writeFile: getCapability("writeFile"),
    mkdir: getCapability("mkdir"),
    rm: getCapability("rm"),
  };
  fs.describeEntry = describeEntry;

  fs.readFile = async (
    path: string,
    options?: ReadFileOptions | BufferEncoding,
  ): Promise<string> => {
    if (input.readFile) {
      return await call(input.readFile, path, options);
    }

    if (input.readFileBuffer) {
      return TEXT_DECODER.decode(await call(input.readFileBuffer, path));
    }

    throw new Error("This mounted filesystem does not support reading files.");
  };

  fs.readFileBuffer = async (path: string): Promise<Uint8Array> => {
    if (input.readFileBuffer) {
      return await call(input.readFileBuffer, path);
    }

    if (input.readFile) {
      return TEXT_ENCODER.encode(await call(input.readFile, path));
    }

    throw new Error("This mounted filesystem does not support reading files.");
  };

  if (input.readFileStream) {
    fs.readFileStream = async (path: string): Promise<ReadableStream<Uint8Array>> =>
      await call(input.readFileStream, path);
  }

  fs.writeFile = async (
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> => {
    if (input.writeFile) {
      await call(input.writeFile, path, content, options);
      return;
    }

    return throwUnsupported("This mounted filesystem does not support writing files.");
  };

  fs.appendFile = async (
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> => {
    if (input.appendFile) {
      await call(input.appendFile, path, content, options);
      return;
    }

    const existing = (await fs.exists(path)) ? await fs.readFileBuffer(path) : new Uint8Array();
    await fs.writeFile(path, concatBytes(existing, toUint8Array(content)), options);
  };

  fs.exists = async (path: string): Promise<boolean> => {
    if (input.exists) {
      return await call(input.exists, path);
    }

    try {
      await fs.stat(path);
      return true;
    } catch {
      return false;
    }
  };

  fs.stat = async (path: string): Promise<FsStat> => {
    if (input.stat) {
      return await call(input.stat, path);
    }

    const descriptor = await describeEntry?.(path, null);
    if (descriptor) {
      return statFromDescriptor(descriptor);
    }

    throw new Error("Path not found.");
  };

  fs.mkdir = async (path: string, options?: MkdirOptions): Promise<void> => {
    if (input.mkdir) {
      await call(input.mkdir, path, options);
      return;
    }

    if (options?.recursive && (await fs.exists(path))) {
      return;
    }

    return throwUnsupported("This mounted filesystem does not support creating directories.");
  };

  fs.readdir = async (path: string): Promise<string[]> => {
    if (input.readdir) {
      return await call(input.readdir, path);
    }

    if (input.readdirWithFileTypes) {
      return (await call(input.readdirWithFileTypes, path)).map((entry) => entry.name);
    }

    throw new Error("This mounted filesystem does not support reading directories.");
  };

  fs.readdirWithFileTypes = async (path: string): Promise<DirentEntry[]> => {
    if (input.readdirWithFileTypes) {
      return await call(input.readdirWithFileTypes, path);
    }

    if (input.readdir) {
      const names = await call(input.readdir, path);
      return Promise.all(
        names.map(async (name) => {
          const stat = await fs.stat(fs.resolvePath(path, name));
          return {
            name,
            isFile: stat.isFile,
            isDirectory: stat.isDirectory,
            isSymbolicLink: stat.isSymbolicLink,
          } satisfies DirentEntry;
        }),
      );
    }

    throw new Error("This mounted filesystem does not support reading directories.");
  };

  fs.rm = async (path: string, options?: RmOptions): Promise<void> => {
    if (input.rm) {
      await call(input.rm, path, options);
      return;
    }

    return throwUnsupported("This mounted filesystem does not support deleting files.");
  };

  fs.cp = async (src: string, dest: string, options?: CpOptions): Promise<void> => {
    if (input.cp) {
      await call(input.cp, src, dest, options);
      return;
    }

    const sourceStat = await fs.stat(src);
    if (sourceStat.isDirectory) {
      if (!options?.recursive) {
        throw new Error("Recursive copy required for directories.");
      }

      await fs.mkdir(dest, { recursive: true });
      for (const entry of await fs.readdir(src)) {
        await fs.cp(fs.resolvePath(src, entry), fs.resolvePath(dest, entry), options);
      }
      return;
    }

    await fs.writeFile(dest, await fs.readFileBuffer(src));
  };

  fs.mv = async (src: string, dest: string): Promise<void> => {
    if (input.mv) {
      await call(input.mv, src, dest);
      return;
    }

    await fs.cp(src, dest, { recursive: true });
    await fs.rm(src, { recursive: true, force: true });
  };

  fs.resolvePath = (base: string, path: string): string => {
    if (input.resolvePath) {
      return call(input.resolvePath, base, path);
    }

    return resolvePath(base, path);
  };

  fs.getAllPaths = (): string[] => {
    if (input.getAllPaths) {
      return call(input.getAllPaths);
    }

    return [];
  };

  fs.chmod = async (path: string, mode: number): Promise<void> => {
    if (input.chmod) {
      await call(input.chmod, path, mode);
      return;
    }

    return throwUnsupported("This mounted filesystem does not support chmod.", "chmod", path);
  };

  fs.symlink = async (target: string, linkPath: string): Promise<void> => {
    if (input.symlink) {
      await call(input.symlink, target, linkPath);
      return;
    }

    return throwUnsupported("This mounted filesystem does not support symlinks.");
  };

  fs.link = async (existingPath: string, newPath: string): Promise<void> => {
    if (input.link) {
      await call(input.link, existingPath, newPath);
      return;
    }

    return throwUnsupported("This mounted filesystem does not support hard links.");
  };

  fs.readlink = async (path: string): Promise<string> => {
    if (input.readlink) {
      return await call(input.readlink, path);
    }

    throw new Error("This mounted filesystem does not support symlinks.");
  };

  fs.lstat = async (path: string): Promise<FsStat> => {
    if (input.lstat) {
      return await call(input.lstat, path);
    }

    return fs.stat(path);
  };

  fs.realpath = async (path: string): Promise<string> => {
    if (input.realpath) {
      return await call(input.realpath, path);
    }

    await fs.stat(path);
    return stripTrailingSlash(normalizeAbsolutePath(path)) || "/";
  };

  fs.utimes = async (path: string, atime: Date, mtime: Date): Promise<void> => {
    if (input.utimes) {
      await call(input.utimes, path, atime, mtime);
      return;
    }

    return throwUnsupported("This mounted filesystem does not support utimes.", "utimes", path);
  };

  return fs;
};

const concatBytes = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left, 0);
  combined.set(right, left.byteLength);
  return combined;
};

const toUint8Array = (value: FileContent): Uint8Array =>
  value instanceof Uint8Array ? value : TEXT_ENCODER.encode(value);

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
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
};

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, "");
