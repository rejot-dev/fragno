import { ensureBuiltInFileContributorsRegistered } from "./contributors";
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
  IFileSystem,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  WriteFileOptions,
} from "./interface";
import { normalizeMountedFileSystem } from "./mounted-file-system";
import { normalizeMountPoint, normalizePathSegments } from "./normalize-path";
import { getRegisteredFileContributors } from "./registry";
import type {
  FileContributor,
  FileMountMetadata,
  FilesContext,
  MountedFileSystem,
  MountedFileSystemInput,
  MountedFileSystemResolution,
  ResolvedFileMount,
} from "./types";

const STANDARD_MOUNT_POINT_ORDER = ["/system", "/workspace"] as const;
const TEXT_ENCODER = new TextEncoder();
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
 * Routing is based on longest-prefix mount matching. The master filesystem also synthesizes `/`
 * and any parent directories implied by nested mount points, so callers can browse the combined
 * namespace without needing each mount to materialize those directories itself.
 */
export class MasterFileSystem implements IFileSystem {
  #mounts: ResolvedFileMount[];
  #routingMounts: ResolvedFileMount[];

  constructor(options: MasterFileSystemOptions) {
    this.#mounts = options.mounts
      .slice()
      .sort((left, right) => compareMountDisplayOrder(left.mountPoint, right.mountPoint));
    this.#routingMounts = options.mounts
      .slice()
      .sort((left, right) => right.mountPoint.length - left.mountPoint.length);
  }

  get mounts(): ReadonlyArray<ResolvedFileMount> {
    return this.#mounts;
  }

  mount(mount: ResolvedFileMount): void {
    const mountPoint = normalizeMountPoint(mount.mountPoint);
    if (this.#mounts.some((m) => m.mountPoint === mountPoint)) {
      throw new Error(`Duplicate file mount point '${mountPoint}' is already registered.`);
    }

    const resolved = { ...mount, mountPoint };
    this.#mounts.push(resolved);
    this.#mounts.sort((left, right) => compareMountDisplayOrder(left.mountPoint, right.mountPoint));
    this.#routingMounts.push(resolved);
    this.#routingMounts.sort((left, right) => right.mountPoint.length - left.mountPoint.length);
  }

  unmount(mountPoint: string): void {
    const normalized = normalizeMountPoint(mountPoint);
    const mountIndex = this.#mounts.findIndex((m) => m.mountPoint === normalized);
    if (mountIndex === -1) {
      throw new Error(`No mount found at '${normalized}'.`);
    }

    this.#mounts.splice(mountIndex, 1);
    const routingIndex = this.#routingMounts.findIndex((m) => m.mountPoint === normalized);
    if (routingIndex !== -1) {
      this.#routingMounts.splice(routingIndex, 1);
    }
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
    const existing = (await this.exists(path)) ? await this.readFileBuffer(path) : new Uint8Array();
    const appended = concatBytes(existing, toUint8Array(content));
    await this.writeFile(path, appended, options);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch {
      return false;
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

    try {
      return await target.fs.stat(normalizedPath);
    } catch {
      // Fall through to descriptor-based metadata below when mounts choose not to expose stat
      // for a path they can still describe.
    }

    const described = await this.#describePath(target, normalizedPath);
    if (described) {
      return createSyntheticStatFromDescriptor(described, target.readOnly);
    }

    throw new Error(`Path '${normalizedPath}' was not found.`);
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
    this.#assertSameMount(src, dest, "copy");

    const sourceStat = await this.stat(src);
    if (sourceStat.isDirectory) {
      if (!options?.recursive) {
        throw new Error("Recursive copy required for directories.");
      }

      await this.mkdir(dest, { recursive: true });
      for (const entry of await this.readdir(src)) {
        await this.cp(this.resolvePath(src, entry), this.resolvePath(dest, entry), options);
      }
      return;
    }

    await this.writeFile(dest, await this.readFileBuffer(src));
  }

  async mv(src: string, dest: string): Promise<void> {
    this.#assertSameMount(src, dest, "move");
    await this.cp(src, dest, { recursive: true });
    await this.rm(src, { recursive: true, force: true });
  }

  resolvePath(base: string, path: string): string {
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
        if (isWithinMount(normalizedPath, mount.mountPoint)) {
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
    fs: MountedFileSystem;
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
    fs: MountedFileSystem;
  } {
    const normalizedPath = normalizeAbsolutePath(path);
    const mount = this.#resolveMount(normalizedPath);

    if (!mount) {
      throw new Error(`Path '${normalizedPath}' is not inside a mounted filesystem.`);
    }

    if (this.#isVirtualOnlyDirectory(normalizedPath, mount)) {
      throw new Error(`Path '${normalizedPath}' is a virtual directory created by mount routing.`);
    }

    return { mount, fs: mount.fs };
  }

  #resolveMount(path: string): ResolvedFileMount | null {
    const normalizedPath = normalizeAbsolutePath(path);
    return (
      this.#routingMounts.find((mount) => isWithinMount(normalizedPath, mount.mountPoint)) ?? null
    );
  }

  #resolveMountOrThrow(path: string): ResolvedFileMount {
    const mount = this.#resolveMount(path);
    if (!mount) {
      throw new Error(`Path '${normalizeAbsolutePath(path)}' is not inside a mounted filesystem.`);
    }

    return mount;
  }

  #assertWritable(mount: ResolvedFileMount, path: string, operation: string): void {
    if (mount.readOnly) {
      throw createReadOnlyFileSystemError(operation, normalizeAbsolutePath(path));
    }
  }

  async #describePath(mount: ResolvedFileMount, path: string, stat?: FsStat | null) {
    if (!mount.fs.describeEntry) {
      return null;
    }

    try {
      return await mount.fs.describeEntry(path, stat);
    } catch {
      return null;
    }
  }

  async #readMountedDirents(mount: ResolvedFileMount, path: string): Promise<DirentEntry[]> {
    try {
      return await mount.fs.readdirWithFileTypes(path);
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
      if (!isAncestorPath(normalizedPath, mount.mountPoint)) {
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

    return this.mounts.some((mount) => isAncestorOrExactPath(normalizedPath, mount.mountPoint));
  }

  #isVirtualOnlyDirectory(path: string, owningMount: ResolvedFileMount): boolean {
    const normalizedPath = stripTrailingSlash(normalizeAbsolutePath(path)) || "/";
    return (
      normalizedPath !== owningMount.mountPoint &&
      this.#getSyntheticChildNames(normalizedPath).length > 0
    );
  }

  #assertSameMount(src: string, dest: string, verb: string): void {
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
  }
}

export const createMasterFileSystem = async (context: FilesContext): Promise<MasterFileSystem> => {
  ensureBuiltInFileContributorsRegistered();

  const normalizedContextOrgId = context.orgId.trim();
  if (!normalizedContextOrgId) {
    throw new Error("Missing organisation id in file system context.");
  }

  const contributors = getRegisteredFileContributors();
  const mounts = [] as ResolvedFileMount[];
  const mountPoints = new Set<string>();

  for (const contributor of contributors) {
    const resolvedMount = await resolveMountedFileSystem(contributor, {
      ...context,
      orgId: normalizedContextOrgId,
    });
    if (!resolvedMount) {
      continue;
    }

    const resolvedFs = isResolvedMountedFileSystemWithOverrides(resolvedMount)
      ? resolvedMount.fs
      : resolvedMount;
    const resolvedMountMeta = isResolvedMountedFileSystemWithOverrides(resolvedMount)
      ? resolvedMount.mount
      : undefined;
    const mountPoint = normalizeMountPoint(resolvedMountMeta?.mountPoint ?? contributor.mountPoint);
    if (mountPoints.has(mountPoint)) {
      throw new Error(`Duplicate file mount point '${mountPoint}' is already registered.`);
    }

    mountPoints.add(mountPoint);
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
      fs: normalizeMountedFileSystem(resolvedFs, { readOnly }),
    });
  }

  return new MasterFileSystem({ mounts });
};

const resolveMountedFileSystem = async (
  contributor: FileContributor,
  context: FilesContext,
): Promise<MountedFileSystemResolution | null> => {
  if (contributor.createFileSystem) {
    return contributor.createFileSystem(context);
  }

  return contributor;
};

const isResolvedMountedFileSystemWithOverrides = (
  value: MountedFileSystemResolution,
): value is {
  fs: MountedFileSystemInput;
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

const createSyntheticStatFromDescriptor = (
  descriptor: {
    kind: "file" | "folder";
    sizeBytes?: number | null;
    updatedAt?: string | Date | null;
  },
  readOnly: boolean,
): FsStat => ({
  isFile: descriptor.kind === "file",
  isDirectory: descriptor.kind === "folder",
  isSymbolicLink: false,
  mode: descriptor.kind === "folder" ? (readOnly ? 0o555 : 0o755) : readOnly ? 0o444 : 0o644,
  size: descriptor.kind === "file" ? (descriptor.sizeBytes ?? 0) : 0,
  mtime: descriptor.updatedAt ? new Date(descriptor.updatedAt) : new Date(0),
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

const isWithinMount = (path: string, mountPoint: string): boolean => {
  const normalizedPath = normalizeAbsolutePath(path);
  const normalizedMountPoint = normalizeMountPoint(mountPoint);
  return (
    normalizedPath === normalizedMountPoint || normalizedPath.startsWith(`${normalizedMountPoint}/`)
  );
};

const isAncestorOrExactPath = (candidateAncestor: string, path: string): boolean => {
  const normalizedAncestor = stripTrailingSlash(normalizeAbsolutePath(candidateAncestor)) || "/";
  const normalizedPath = stripTrailingSlash(normalizeAbsolutePath(path)) || "/";
  return (
    normalizedAncestor === normalizedPath || normalizedPath.startsWith(`${normalizedAncestor}/`)
  );
};

const isAncestorPath = (candidateAncestor: string, path: string): boolean => {
  const normalizedAncestor = stripTrailingSlash(normalizeAbsolutePath(candidateAncestor)) || "/";
  const normalizedPath = stripTrailingSlash(normalizeAbsolutePath(path)) || "/";

  if (normalizedAncestor === "/") {
    return normalizedPath !== "/";
  }

  return normalizedPath.startsWith(`${normalizedAncestor}/`);
};

const getRelativeMountRemainder = (ancestorPath: string, path: string): string => {
  const normalizedAncestor = stripTrailingSlash(normalizeAbsolutePath(ancestorPath)) || "/";
  const normalizedPath = stripTrailingSlash(normalizeAbsolutePath(path)) || "/";

  if (normalizedAncestor === "/") {
    return normalizedPath.slice(1);
  }

  return normalizedPath.slice(normalizedAncestor.length + 1);
};

const normalizeAbsolutePath = (value: string): string => {
  const normalized = value.trim().replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
};

const normalizeDirectoryPath = (value: string): string => {
  const normalized = normalizeAbsolutePath(value);
  return normalized === "/"
    ? normalized
    : value.trim().endsWith("/")
      ? `${stripTrailingSlash(normalized)}/`
      : normalized;
};

const stripTrailingSlash = (value: string): string => {
  if (value === "/") {
    return value;
  }

  return value.replace(/\/+$/, "");
};

const toUint8Array = (content: FileContent): Uint8Array =>
  content instanceof Uint8Array ? content : TEXT_ENCODER.encode(content);

const concatBytes = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left, 0);
  combined.set(right, left.length);
  return combined;
};
