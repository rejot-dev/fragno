import { getBuiltInFileContributors } from "./contributors";
import {
  FileSystemError,
  createReadOnlyFileSystemError,
  createPathNotFoundFileSystemError,
  createUnsupportedOperationFileSystemError,
} from "./fs-errors";
import type {
  BufferEncoding,
  CpOptions,
  DirentEntry,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  WriteFileOptions,
} from "./interface";
import {
  normalizeAbsolutePath,
  normalizeDirectoryPath,
  isPathWithin,
  normalizeMountPoint,
  normalizePathSegments,
  resolvePath as resolveFilePath,
  stripTrailingSlash,
} from "./normalize-path";
import type { FileGroup, FileSubject } from "./permissions";
import type {
  FileContributor,
  FileMountMetadata,
  FilesContext,
  FileSystemResolution,
  ResolvedFileMount,
} from "./types";

const STANDARD_MOUNT_POINT_ORDER = ["/system", "/workspace", "/r2", "/r2-remote"] as const;
const ROOT_DIR_MODE = 0o755;
const FILE_SYSTEM_SORTER = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

export type MasterFileSystemOptions = {
  mounts: ReadonlyArray<ResolvedFileMount>;
};

/**
 * Central router for the mounted files architecture.
 *
 * It is the single entrypoint higher layers should use when working with the combined files view.
 * Routing is based on mount ownership. Mount points must not overlap, and the master filesystem
 * synthesizes `/` plus parent directories implied by deep mount points so callers can browse the
 * combined namespace without needing each mount to materialize those directories itself.
 */
export class MasterFileSystem implements IFileSystem {
  #mounts: ResolvedFileMount[];

  constructor(options: MasterFileSystemOptions) {
    const mounts = normalizeAndValidateMounts(options.mounts);
    this.#mounts = mounts
      .slice()
      .sort((left, right) => compareMountDisplayOrder(left.mountPoint, right.mountPoint));
  }

  get mounts(): ReadonlyArray<ResolvedFileMount> {
    return this.#mounts;
  }

  mount(mount: ResolvedFileMount): void {
    const mountPoint = normalizeMountPoint(mount.mountPoint);
    assertMountPointAvailable(mountPoint, this.#mounts);
    const resolved = { ...mount, mountPoint };
    this.#mounts.push(resolved);
    this.#mounts.sort((left, right) => compareMountDisplayOrder(left.mountPoint, right.mountPoint));
  }

  unmount(mountPoint: string): void {
    const normalized = normalizeMountPoint(mountPoint);
    const mountIndex = this.#mounts.findIndex((m) => m.mountPoint === normalized);
    if (mountIndex === -1) {
      throw new Error(`No mount found at '${normalized}'.`);
    }

    this.#mounts.splice(mountIndex, 1);
  }

  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    const target = this.#resolveReadTarget(path);
    return target.fs.readFile(path, options);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const target = this.#resolveReadTarget(path);
    return target.fs.readFileBuffer(path);
  }

  async readFileStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const target = this.#resolveReadTarget(path);
    if (!target.fs.readFileStream) {
      throw createUnsupportedOperationFileSystemError("read stream", path);
    }

    return target.fs.readFileStream(path);
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const target = this.#resolveWriteTarget(path);
    this.#assertWritable(target.mount, path, "write");

    await target.fs.writeFile(path, content, options);
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const target = this.#resolveWriteTarget(path);
    this.#assertWritable(target.mount, path, "append");

    await target.fs.appendFile(path, content, options);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch (error) {
      if (error instanceof FileSystemError && error.code === "ENOENT") {
        return false;
      }

      throw error;
    }
  }

  async stat(path: string): Promise<FsStat> {
    const normalizedPath = normalizeAbsolutePath(path);

    if (this.#isSyntheticDirectory(normalizedPath)) {
      const target = this.#resolveMount(normalizedPath);
      if (target?.mountPoint === normalizedPath && target.fs.stat) {
        try {
          return await target.fs.stat(normalizedPath);
        } catch {
          // fall back to a synthetic directory stat below
        }
      }

      return createSyntheticDirectoryStat(target?.readOnly ?? false);
    }

    const target = this.#resolveMountOrThrow(normalizedPath);

    return target.fs.stat(normalizedPath);
  }

  async lstat(path: string): Promise<FsStat> {
    const normalizedPath = normalizeAbsolutePath(path);
    if (this.#isSyntheticDirectory(normalizedPath)) {
      return this.stat(normalizedPath);
    }

    const target = this.#resolveMountOrThrow(normalizedPath);
    return target.fs.lstat(normalizedPath);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const target = this.#resolveWriteTarget(path);
    this.#assertWritable(target.mount, path, "mkdir");

    await target.fs.mkdir(path, options);
  }

  async readdir(path: string): Promise<string[]> {
    const dirents = await this.readdirWithFileTypes(path);
    return dirents.map((entry) => entry.name);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const normalizedPath = normalizeDirectoryPath(path);
    await this.#assertDirectory(normalizedPath);

    const entries = new Map<string, DirentEntry>();
    const target = this.#resolveMount(normalizedPath);

    if (target) {
      const mountEntries = await this.#readMountedDirents(target, normalizedPath);
      for (const entry of mountEntries) {
        entries.set(entry.name, entry);
      }
    }

    for (const name of this.#getSyntheticChildNames(normalizedPath)) {
      entries.set(name, {
        name,
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
      });
    }

    return Array.from(entries.values()).sort((left, right) =>
      FILE_SYSTEM_SORTER.compare(left.name, right.name),
    );
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const target = this.#resolveWriteTarget(path);
    this.#assertWritable(target.mount, path, "rm");

    await target.fs.rm(path, options);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const mount = this.#assertSameMount(src, dest, "copy");
    this.#assertWritable(mount, dest, "copy");

    await mount.fs.cp(src, dest, options);
  }

  async mv(src: string, dest: string): Promise<void> {
    const mount = this.#assertSameMount(src, dest, "move");
    this.#assertWritable(mount, src, "move");
    this.#assertWritable(mount, dest, "move");

    await mount.fs.mv(src, dest);
  }

  resolvePath(base: string, path: string): string {
    return resolveFilePath(base, path);
  }

  getAllPaths(): string[] {
    const paths = new Set<string>(["/"]);

    for (const mount of this.mounts) {
      for (const ancestor of getMountAncestors(mount.mountPoint)) {
        paths.add(ancestor);
      }
      paths.add(mount.mountPoint);

      for (const path of mount.fs.getAllPaths()) {
        const normalizedPath = normalizeAbsolutePath(path);
        if (isPathWithin(normalizedPath, mount.mountPoint)) {
          paths.add(normalizedPath);
        }
      }
    }

    return Array.from(paths).sort(comparePaths);
  }

  async chmod(path: string, mode: number): Promise<void> {
    const target = this.#resolveWriteTarget(path);
    this.#assertWritable(target.mount, path, "chmod");

    await target.fs.chmod(path, mode);
  }

  async chown(path: string, owner: FileSubject, group?: FileGroup): Promise<void> {
    const target = this.#resolveWriteTarget(path);
    this.#assertWritable(target.mount, path, "chown");
    if (!target.fs.chown) {
      throw createUnsupportedOperationFileSystemError("chown", path);
    }

    await target.fs.chown(path, owner, group);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    const linkTarget = this.#resolveWriteTarget(linkPath);
    this.#assertWritable(linkTarget.mount, linkPath, "symlink");

    await linkTarget.fs.symlink(target, linkPath);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    this.#assertSameMount(existingPath, newPath, "hard-link");

    const target = this.#resolveWriteTarget(newPath);
    this.#assertWritable(target.mount, newPath, "link");

    await target.fs.link(existingPath, newPath);
  }

  async readlink(path: string): Promise<string> {
    const target = this.#resolveMountOrThrow(path);
    return target.fs.readlink(path);
  }

  async realpath(path: string): Promise<string> {
    const normalizedPath = normalizeAbsolutePath(path);
    if (this.#isSyntheticDirectory(normalizedPath)) {
      return stripTrailingSlash(normalizedPath) || "/";
    }

    const target = this.#resolveMountOrThrow(normalizedPath);
    return target.fs.realpath(normalizedPath);
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    const target = this.#resolveWriteTarget(path);
    this.#assertWritable(target.mount, path, "utimes");

    await target.fs.utimes(path, atime, mtime);
  }

  getMountForPath(path: string): ResolvedFileMount | null {
    return this.#resolveMount(path);
  }

  #resolveReadTarget(path: string): {
    mount: ResolvedFileMount;
    fs: IFileSystem;
  } {
    const normalizedPath = normalizeAbsolutePath(path);

    if (this.#isSyntheticDirectory(normalizedPath)) {
      throw new Error(`Path '${normalizedPath}' is a directory.`);
    }

    const mount = this.#resolveMountOrThrow(normalizedPath);
    return { mount, fs: mount.fs };
  }

  #resolveWriteTarget(path: string): {
    mount: ResolvedFileMount;
    fs: IFileSystem;
  } {
    const normalizedPath = normalizeAbsolutePath(path);
    const mount = this.#resolveMount(normalizedPath);

    if (!mount) {
      throw new Error(`Path '${normalizedPath}' is not inside a mounted filesystem.`);
    }

    return { mount, fs: mount.fs };
  }

  #resolveMount(path: string): ResolvedFileMount | null {
    const normalizedPath = normalizeAbsolutePath(path);
    return this.#mounts.find((mount) => isPathWithin(normalizedPath, mount.mountPoint)) ?? null;
  }

  #resolveMountOrThrow(path: string): ResolvedFileMount {
    const mount = this.#resolveMount(path);
    if (!mount) {
      throw createPathNotFoundFileSystemError("resolve", normalizeAbsolutePath(path));
    }

    return mount;
  }

  #assertWritable(mount: ResolvedFileMount, path: string, operation: string): void {
    const normalizedPath = normalizeAbsolutePath(path);
    if (mount.readOnly) {
      throw createReadOnlyFileSystemError(operation, normalizedPath);
    }
  }

  async #readMountedDirents(mount: ResolvedFileMount, path: string): Promise<DirentEntry[]> {
    try {
      if (mount.fs.readdirWithFileTypes) {
        return await mount.fs.readdirWithFileTypes(path);
      }

      return Promise.all(
        (await mount.fs.readdir(path)).map(async (name) => {
          const stat = await mount.fs.stat(resolveFilePath(path, name));
          return {
            name,
            isFile: stat.isFile,
            isDirectory: stat.isDirectory,
            isSymbolicLink: stat.isSymbolicLink,
          };
        }),
      );
    } catch {
      return [];
    }
  }

  async #assertDirectory(path: string): Promise<void> {
    const stat = await this.stat(path);
    if (!stat.isDirectory) {
      throw new Error(`Path '${path}' is not a directory.`);
    }
  }

  #getSyntheticChildNames(path: string): string[] {
    const normalizedPath = stripTrailingSlash(normalizeAbsolutePath(path)) || "/";
    const childNames = new Set<string>();

    for (const mount of this.mounts) {
      if (!isPathWithin(mount.mountPoint, normalizedPath) || normalizedPath === mount.mountPoint) {
        continue;
      }

      const remainder = getRelativeMountRemainder(normalizedPath, mount.mountPoint);
      const nextSegment = remainder.split("/").filter(Boolean)[0];
      if (nextSegment) {
        childNames.add(nextSegment);
      }
    }

    return Array.from(childNames).sort(FILE_SYSTEM_SORTER.compare);
  }

  #isSyntheticDirectory(path: string): boolean {
    const normalizedPath = stripTrailingSlash(normalizeAbsolutePath(path)) || "/";

    if (normalizedPath === "/") {
      return true;
    }

    return this.mounts.some((mount) => isPathWithin(mount.mountPoint, normalizedPath));
  }

  #assertSameMount(src: string, dest: string, verb: string): ResolvedFileMount {
    const sourceMount = this.#resolveMount(src);
    const destinationMount = this.#resolveMount(dest);

    if (
      !sourceMount ||
      !destinationMount ||
      sourceMount.mountPoint !== destinationMount.mountPoint
    ) {
      throw new Error(
        `Cross-mount ${verb} is not supported yet. Source '${normalizeAbsolutePath(src)}' and destination '${normalizeAbsolutePath(dest)}' must resolve to the same mount.`,
      );
    }

    return sourceMount;
  }
}

export type CreateMasterFileSystemOptions = {
  contributors?: ReadonlyArray<FileContributor>;
};

export const createMasterFileSystem = async (
  context: FilesContext,
  options: CreateMasterFileSystemOptions = {},
): Promise<MasterFileSystem> => {
  const normalizedContextOrgId = context.orgId.trim();
  if (!normalizedContextOrgId) {
    throw new Error("Missing organisation id in file system context.");
  }

  const contributors = options.contributors ?? getBuiltInFileContributors();
  const mounts = [] as ResolvedFileMount[];

  for (const contributor of contributors) {
    const resolvedMount = await resolveFileSystem(contributor, {
      ...context,
      orgId: normalizedContextOrgId,
    });
    if (!resolvedMount) {
      continue;
    }

    const resolvedFs = hasFileSystemOverrides(resolvedMount) ? resolvedMount.fs : resolvedMount;
    const resolvedMountMeta = hasFileSystemOverrides(resolvedMount)
      ? resolvedMount.mount
      : undefined;
    const mountPoint = normalizeMountPoint(resolvedMountMeta?.mountPoint ?? contributor.mountPoint);
    assertMountPointAvailable(mountPoint, mounts);
    const readOnly = resolvedMountMeta?.readOnly ?? contributor.readOnly;

    mounts.push({
      id: resolvedMountMeta?.id ?? contributor.id,
      kind: resolvedMountMeta?.kind ?? contributor.kind,
      mountPoint,
      title: resolvedMountMeta?.title ?? contributor.title,
      readOnly,
      persistence: resolvedMountMeta?.persistence ?? contributor.persistence,
      description: resolvedMountMeta?.description ?? contributor.description,
      uploadProvider: resolvedMountMeta?.uploadProvider ?? contributor.uploadProvider,
      fs: resolvedFs,
    });
  }

  return new MasterFileSystem({ mounts });
};

const resolveFileSystem = async (
  contributor: FileContributor,
  context: FilesContext,
): Promise<FileSystemResolution | null> => {
  if (contributor.createFileSystem) {
    return contributor.createFileSystem(context);
  }

  return contributor as IFileSystem;
};

const hasFileSystemOverrides = (
  value: FileSystemResolution,
): value is {
  fs: IFileSystem;
  mount?: Partial<FileMountMetadata>;
} => typeof value === "object" && value !== null && "fs" in value;

const createSyntheticDirectoryStat = (readOnly: boolean): FsStat => ({
  isFile: false,
  isDirectory: true,
  isSymbolicLink: false,
  mode: readOnly ? 0o555 : ROOT_DIR_MODE,
  size: 0,
  mtime: new Date(0),
});

const compareMountDisplayOrder = (left: string, right: string): number => {
  const leftRank = getStandardMountPointOrder(left);
  const rightRank = getStandardMountPointOrder(right);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  return comparePaths(left, right);
};

const getStandardMountPointOrder = (mountPoint: string): number => {
  const rank = STANDARD_MOUNT_POINT_ORDER.indexOf(
    mountPoint as (typeof STANDARD_MOUNT_POINT_ORDER)[number],
  );
  return rank === -1 ? STANDARD_MOUNT_POINT_ORDER.length : rank;
};

const normalizeAndValidateMounts = (
  mounts: ReadonlyArray<ResolvedFileMount>,
): ResolvedFileMount[] => {
  const normalizedMounts: ResolvedFileMount[] = [];

  for (const mount of mounts) {
    const mountPoint = normalizeMountPoint(mount.mountPoint);
    assertMountPointAvailable(mountPoint, normalizedMounts);
    normalizedMounts.push({ ...mount, mountPoint });
  }

  return normalizedMounts;
};

const assertMountPointAvailable = (
  mountPoint: string,
  existingMounts: ReadonlyArray<ResolvedFileMount>,
): void => {
  for (const existingMount of existingMounts) {
    const existingMountPoint = normalizeMountPoint(existingMount.mountPoint);
    if (existingMountPoint === mountPoint) {
      throw new Error(`Duplicate file mount point '${mountPoint}' is already registered.`);
    }

    if (isOverlappingMountPoint(existingMountPoint, mountPoint)) {
      throw new Error(
        `Overlapping file mount points are not supported: '${existingMountPoint}' and '${mountPoint}'.`,
      );
    }
  }
};

const isOverlappingMountPoint = (left: string, right: string): boolean =>
  isPathWithin(left, right) || isPathWithin(right, left);

const comparePaths = (left: string, right: string): number => {
  const leftSegments = normalizeAbsolutePath(left).split("/").filter(Boolean);
  const rightSegments = normalizeAbsolutePath(right).split("/").filter(Boolean);
  const maxLength = Math.max(leftSegments.length, rightSegments.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftSegment = leftSegments[index];
    const rightSegment = rightSegments[index];
    if (leftSegment === undefined) {
      return -1;
    }
    if (rightSegment === undefined) {
      return 1;
    }

    const compared = FILE_SYSTEM_SORTER.compare(leftSegment, rightSegment);
    if (compared !== 0) {
      return compared;
    }
  }

  return 0;
};

const getMountAncestors = (mountPoint: string): string[] => {
  const segments = normalizePathSegments(mountPoint);
  const ancestors = [] as string[];

  for (let index = 1; index <= segments.length; index += 1) {
    ancestors.push(`/${segments.slice(0, index).join("/")}`);
  }

  return ancestors;
};

const getRelativeMountRemainder = (ancestorPath: string, path: string): string => {
  const normalizedAncestor = stripTrailingSlash(normalizeAbsolutePath(ancestorPath)) || "/";
  const normalizedPath = stripTrailingSlash(normalizeAbsolutePath(path)) || "/";

  if (normalizedAncestor === "/") {
    return normalizedPath.slice(1);
  }

  return normalizedPath.slice(normalizedAncestor.length + 1);
};
