import type { MkdirOptions, MountBucketOptions, SandboxHandle } from "@/sandbox/contracts";

import { createStarterMountedFileSystem } from "./contributors/starter";
import type { MasterFileSystem } from "./master-file-system";
import { normalizeMountPoint } from "./normalize-path";
import type {
  FileSystemArtifact,
  FilesBackend,
  MountedFileSystem,
  ResolvedFileMount,
} from "./types";

export type SandboxBootstrapMarker = {
  version: 1;
  orgId: string;
  backend: FilesBackend;
  roots: ReadonlyArray<{
    id: string;
    kind: ResolvedFileMount["kind"];
    mountPoint: string;
  }>;
};

export type UploadMountConfig = {
  bucket: string;
  options: MountBucketOptions;
};

export type ResolveUploadMount = (root: ResolvedFileMount) => Promise<UploadMountConfig | null>;

export type PrepareSandboxFileSystemOptions = {
  orgId: string;
  backend: FilesBackend;
  fileSystem: MasterFileSystem;
  handle: SandboxHandle;
  resolveUploadMount?: ResolveUploadMount;
};

export const BOOTSTRAP_SENTINEL_PATH = "/.fragno/files-bootstrap.json";
const BOOTSTRAP_MARKER_VERSION = 1;

export const hasBootstrapSentinel = async (handle: SandboxHandle): Promise<boolean> => {
  const result = await handle.exists(BOOTSTRAP_SENTINEL_PATH);
  return result.exists;
};

export const writeArtifactToSandbox = async (
  handle: SandboxHandle,
  path: string,
  artifact: FileSystemArtifact,
  options?: { encoding?: "utf-8" | "base64" },
): Promise<void> => {
  if (artifact instanceof Uint8Array) {
    await handle.writeFile(path, toBase64String(artifact), {
      ...options,
      encoding: "base64",
    });
    return;
  }

  await handle.writeFile(path, artifact, { ...options, encoding: options?.encoding ?? "utf-8" });
};

export async function prepareSandboxFileSystem(
  options: PrepareSandboxFileSystemOptions,
): Promise<void> {
  const { orgId, backend, fileSystem, handle, resolveUploadMount } = options;

  if (await hasBootstrapSentinel(handle)) {
    return;
  }

  const bucketMounts = await resolveBucketMounts({
    mounts: fileSystem.mounts,
    resolveUploadMount,
  });

  await materializeBootstrapMounts({
    handle,
    mounts: fileSystem.mounts,
    bucketMounts,
  });
  await mountBucketRoots({ handle, bucketMounts });
  await ensureDirectory(handle, "/workspace");

  const marker: SandboxBootstrapMarker = {
    version: BOOTSTRAP_MARKER_VERSION,
    orgId,
    backend,
    roots: fileSystem.mounts.map((mount) => ({
      id: mount.id,
      kind: mount.kind,
      mountPoint: mount.mountPoint,
    })),
  };

  await writeArtifactToSandbox(handle, BOOTSTRAP_SENTINEL_PATH, JSON.stringify(marker), {
    encoding: "utf-8",
  });
}

type ResolvedBucketMount = {
  mount: ResolvedFileMount;
  config: UploadMountConfig;
};

type SandboxBootstrapMount = {
  mount: ResolvedFileMount;
  fs: MountedFileSystem;
};

const resolveBucketMounts = async ({
  mounts,
  resolveUploadMount,
}: {
  mounts: ReadonlyArray<ResolvedFileMount>;
  resolveUploadMount?: ResolveUploadMount;
}): Promise<ResolvedBucketMount[]> => {
  const persistentMounts = mounts.filter(
    (mount) => mount.persistence === "persistent" && !mount.readOnly,
  );
  if (persistentMounts.length === 0) {
    return [];
  }

  if (!resolveUploadMount) {
    throw new Error(
      "Persistent filesystem mounts found but no upload mount resolver was provided.",
    );
  }

  const bucketMounts: ResolvedBucketMount[] = [];
  const unresolvedMountPoints: string[] = [];

  for (const mount of persistentMounts) {
    const config = await resolveUploadMount(mount);
    if (!config) {
      unresolvedMountPoints.push(mount.mountPoint);
      continue;
    }

    bucketMounts.push({ mount, config });
  }

  if (unresolvedMountPoints.length > 0) {
    throw new Error(
      `Upload mount configuration missing for ${unresolvedMountPoints.map((mountPoint) => `'${mountPoint}'`).join(", ")}.`,
    );
  }

  return bucketMounts;
};

const mountBucketRoots = async ({
  handle,
  bucketMounts,
}: {
  handle: SandboxHandle;
  bucketMounts: ReadonlyArray<ResolvedBucketMount>;
}) => {
  await Promise.all(
    bucketMounts.map(async ({ mount, config }) => {
      await ensureDirectory(handle, mount.mountPoint);
      await handle.mountBucket(config.bucket, mount.mountPoint, config.options);
    }),
  );
};

const materializeBootstrapMounts = async ({
  handle,
  mounts,
  bucketMounts,
}: {
  handle: SandboxHandle;
  mounts: ReadonlyArray<ResolvedFileMount>;
  bucketMounts: ReadonlyArray<ResolvedBucketMount>;
}) => {
  const bucketBackedMountPoints = new Set(bucketMounts.map(({ mount }) => mount.mountPoint));

  for (const { mount, fs } of resolveBootstrapMounts(mounts, bucketBackedMountPoints)) {
    await ensureDirectory(handle, mount.mountPoint);
    await materializeMountTree({ handle, mount, fs, path: mount.mountPoint });
  }
};

const resolveBootstrapMounts = (
  mounts: ReadonlyArray<ResolvedFileMount>,
  bucketBackedMountPoints: ReadonlySet<string>,
): SandboxBootstrapMount[] =>
  mounts.flatMap((mount) => {
    if (!bucketBackedMountPoints.has(mount.mountPoint)) {
      return [{ mount, fs: mount.fs }];
    }

    if (mount.kind !== "starter") {
      return [];
    }

    return [{ mount, fs: createStarterMountedFileSystem() }];
  });

const materializeMountTree = async ({
  handle,
  mount,
  fs,
  path,
}: {
  handle: SandboxHandle;
  mount: ResolvedFileMount;
  fs: MountedFileSystem;
  path: string;
}): Promise<void> => {
  const stat = await fs.stat?.(path);
  if (!stat) {
    return;
  }

  if (stat.isDirectory) {
    await ensureDirectory(handle, path);

    const entries = fs.readdirWithFileTypes
      ? await fs.readdirWithFileTypes(path)
      : await describeDirentsFromNames(mount, path, fs);

    for (const entry of entries) {
      await materializeMountTree({
        handle,
        mount,
        fs,
        path: resolvePath(path, entry.name),
      });
    }

    return;
  }

  const artifact = await readMountedArtifact(fs, mount, path);
  await ensureDirectory(handle, toParentPath(path));

  if (mount.kind === "starter") {
    const exists = await handle.exists(path);
    if (exists.exists) {
      return;
    }
  }

  await writeArtifactToSandbox(handle, path, artifact);
};

const describeDirentsFromNames = async (mount: ResolvedFileMount, path: string, fs = mount.fs) => {
  const names = (await fs.readdir?.(path)) ?? [];
  return Promise.all(
    names.map(async (name) => {
      const childPath = resolvePath(path, name);
      const stat = await fs.stat?.(childPath);
      if (!stat) {
        throw new Error(`Unable to stat mounted path '${childPath}'.`);
      }

      return {
        name,
        isFile: stat.isFile,
        isDirectory: stat.isDirectory,
        isSymbolicLink: stat.isSymbolicLink,
      };
    }),
  );
};

const readMountedArtifact = async (
  fs: MountedFileSystem,
  mount: ResolvedFileMount,
  path: string,
): Promise<FileSystemArtifact> => {
  if (fs.readFile) {
    return fs.readFile(path, { encoding: "utf-8" });
  }

  if (fs.readFileBuffer) {
    return fs.readFileBuffer(path);
  }

  throw new Error(`Mounted filesystem '${mount.mountPoint}' cannot materialize file '${path}'.`);
};

const ensureDirectory = async (handle: SandboxHandle, path: string, options?: MkdirOptions) => {
  const normalizedPath = normalizeMountPoint(path);
  await handle.mkdir(normalizedPath, {
    recursive: true,
    ...options,
  });
};

const resolvePath = (base: string, path: string): string => {
  if (path.startsWith("/")) {
    return normalizeMountPoint(path);
  }

  return normalizeMountPoint(`${base}/${path}`);
};

const toParentPath = (path: string): string => {
  const normalized = normalizeMountPoint(path);
  const segments = normalized.split("/").filter(Boolean);

  if (segments.length <= 1) {
    return "/";
  }

  return `/${segments.slice(0, -1).join("/")}`;
};

const toBase64String = (value: Uint8Array): string => {
  if (typeof btoa !== "function") {
    throw new Error("btoa is unavailable; cannot serialize binary artifact.");
  }

  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};
