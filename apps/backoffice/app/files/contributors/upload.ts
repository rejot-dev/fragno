import {
  UPLOAD_PROVIDER_R2,
  UPLOAD_PROVIDER_R2_BINDING,
  type UploadAdminConfigResponse,
  type UploadProvider,
} from "@/fragno/upload";
import type { UploadFileRecord } from "@/routes/backoffice/connections/upload/data";

import {
  createInvalidArgumentFileSystemError,
  createPathNotFoundFileSystemError,
  createUnsupportedOperationFileSystemError,
} from "../fs-errors";
import type { FileContent, FsStat } from "../interface";
import { normalizeMountedFileSystem } from "../mounted-file-system";
import type {
  FileContributor,
  FileEntryDescriptor,
  FileMountMetadata,
  FilesContext,
  MountedFileSystem,
} from "../types";
import {
  createUploadDirectoryMarkerMetadata,
  getUploadDirectoryMarkerFolderKey,
  getUploadDirectoryMarkerFilename,
  isUploadDirectoryMarker,
  toUploadDirectoryMarkerFileKey,
} from "./upload-markers";

export const UPLOAD_FILE_CONTRIBUTOR_ID = "upload";
export const UPLOAD_FILE_MOUNT_ID = "uploads";
export const UPLOAD_FILE_MOUNT_POINT = "/uploads";
const UNKNOWN_MTIME = new Date(0);
const TEXT_ENCODER = new TextEncoder();
const UPLOAD_FS_METADATA_KEY = "__docsFs";
const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_FOLDER_MODE = 0o755;

export const uploadFileMount: FileMountMetadata = {
  id: UPLOAD_FILE_MOUNT_ID,
  kind: "upload",
  mountPoint: UPLOAD_FILE_MOUNT_POINT,
  title: "Uploads",
  readOnly: false,
  persistence: "persistent",
  description: "Persistent org-scoped uploads routed through the Upload fragment.",
};

export const uploadFileContributor: FileContributor = {
  ...uploadFileMount,
  async createFileSystem(ctx) {
    if (!isUploadConfigured(ctx.uploadConfig)) {
      return null;
    }

    const provider = resolveBoundUploadProvider(ctx.uploadConfig);
    return {
      fs: createUploadMountedFileSystem(ctx, { provider }),
      mount: resolveUploadFileMount(ctx.uploadConfig, { provider }) ?? undefined,
    };
  },
};

export type CreateUploadMountedFileSystemOptions = {
  mountPoint?: string;
  provider?: UploadProvider;
};

export const createUploadMountedFileSystem = (
  ctx: FilesContext,
  options: CreateUploadMountedFileSystemOptions = {},
): MountedFileSystem => {
  const mountPoint = normalizeAbsolutePath(options.mountPoint ?? UPLOAD_FILE_MOUNT_POINT);
  const provider = resolveBoundUploadProvider(ctx.uploadConfig, options.provider);

  return normalizeMountedFileSystem({
    async describeEntry(path) {
      const normalizedPath = path.endsWith("/") ? ensureFolderPath(path) : stripTrailingSlash(path);
      const relativePath = stripLeadingSlash(stripTrailingSlash(path).slice(mountPoint.length));

      if (!path.endsWith("/") && relativePath) {
        const result = await fetchUploadFileFromRuntime(ctx, provider, relativePath);
        if (result && !isUploadDirectoryMarker(result)) {
          return toFileDescriptor(mountPoint, result, buildUploadContentUrl(ctx, result));
        }
      }

      const tree = buildUploadTree(mountPoint, await listAllUploadFiles(ctx, provider));
      return findEntry(tree, normalizedPath);
    },
    async exists(path) {
      if (stripTrailingSlash(path) === mountPoint) {
        return true;
      }

      return (await this.describeEntry?.(path)) !== null;
    },
    async stat(path) {
      if (stripTrailingSlash(path) === mountPoint) {
        return createRootStat();
      }

      const entry = await this.describeEntry?.(path);
      if (!entry) {
        throw new Error("Path not found.");
      }

      return toFsStat(entry, false);
    },
    async readdir(path) {
      const tree = buildUploadTree(mountPoint, await listAllUploadFiles(ctx, provider));
      if (stripTrailingSlash(path) === mountPoint) {
        return tree.map((entry) => getLeafSegment(stripTrailingSlash(entry.path)));
      }

      const node = findEntry(tree, ensureFolderPath(path));
      return node?.kind === "folder"
        ? (node.children ?? []).map((entry) => getLeafSegment(stripTrailingSlash(entry.path)))
        : [];
    },
    async readdirWithFileTypes(path) {
      const tree = buildUploadTree(mountPoint, await listAllUploadFiles(ctx, provider));
      const directory =
        stripTrailingSlash(path) === mountPoint ? null : findEntry(tree, ensureFolderPath(path));
      const entries =
        stripTrailingSlash(path) === mountPoint
          ? tree
          : directory?.kind === "folder"
            ? (directory.children ?? [])
            : [];

      return entries.map((entry) => ({
        name: getLeafSegment(stripTrailingSlash(entry.path)),
        isFile: entry.kind === "file",
        isDirectory: entry.kind === "folder",
        isSymbolicLink: false,
      }));
    },
    async readFile(path) {
      const detail = await fetchUploadFileFromRuntime(
        ctx,
        provider,
        stripLeadingSlash(path.slice(mountPoint.length)),
      );
      if (!detail || isUploadDirectoryMarker(detail)) {
        throw new Error("File not found.");
      }
      if (!isProbablyTextContent(resolveUploadContentType(detail), detail.fileKey)) {
        throw new Error("Binary files cannot be read as text.");
      }

      const response = await requestUpload(ctx, "GET", "/files/by-key/content", {
        query: {
          provider: detail.provider,
          key: detail.fileKey,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to read file (${response.status}).`);
      }

      return response.text();
    },
    async readFileBuffer(path) {
      const detail = await fetchUploadFileFromRuntime(
        ctx,
        provider,
        stripLeadingSlash(path.slice(mountPoint.length)),
      );
      if (!detail || isUploadDirectoryMarker(detail)) {
        throw new Error("File not found.");
      }

      const response = await requestUpload(ctx, "GET", "/files/by-key/content", {
        query: {
          provider: detail.provider,
          key: detail.fileKey,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to read file (${response.status}).`);
      }

      return new Uint8Array(await response.arrayBuffer());
    },
    async readFileStream(path) {
      const detail = await fetchUploadFileFromRuntime(
        ctx,
        provider,
        stripLeadingSlash(path.slice(mountPoint.length)),
      );
      if (!detail || isUploadDirectoryMarker(detail)) {
        throw new Error("File not found.");
      }

      const response = await requestUpload(ctx, "GET", "/files/by-key/content", {
        query: {
          provider: detail.provider,
          key: detail.fileKey,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to read file (${response.status}).`);
      }

      if (!response.body) {
        throw createUnsupportedOperationFileSystemError("read stream", path);
      }

      return response.body;
    },
    async writeFile(path, content) {
      const { fileKey, isRoot } = toRelativeUploadPath(mountPoint, path);
      if (isRoot || !fileKey) {
        throw new Error(`Cannot write to the mounted upload root '${mountPoint}'.`);
      }

      for (const folderKey of getAncestorFolderKeys(getParentUploadFileKey(fileKey))) {
        await ensureUploadDirectoryMarker(ctx, provider, folderKey);
      }

      const existing = await fetchUploadFileFromRuntime(ctx, provider, fileKey);
      if (existing) {
        await deleteUploadRecord(ctx, existing);
      }

      const blob = toBlob(
        content,
        resolveUploadContentType(existing ?? { fileKey, contentType: null }),
      );
      const form = new FormData();
      form.set(
        "file",
        new File([blob], getLeafSegment(fileKey), {
          type: blob.type || undefined,
        }),
      );
      form.set("provider", provider);
      form.set("fileKey", fileKey);
      form.set("filename", getLeafSegment(fileKey));

      const preservedMetadata = existing
        ? preserveUploadMetadataForRewrite(existing.metadata)
        : null;
      if (preservedMetadata) {
        form.set("metadata", JSON.stringify(preservedMetadata));
      }

      const response = await requestUpload(ctx, "POST", "/files", {
        body: form,
      });
      if (!response.ok) {
        throw new Error(await readResponseMessage(response, "Unable to write upload-backed file."));
      }
    },
    async mkdir(path, options) {
      const { fileKey, isRoot } = toRelativeUploadPath(mountPoint, path);
      if (isRoot || !fileKey) {
        return;
      }

      const folderKey = stripTrailingSlash(fileKey);
      if (await uploadFolderExists(ctx, provider, mountPoint, folderKey)) {
        return;
      }

      const parentFolderKey = getParentUploadFileKey(folderKey);
      if (!options?.recursive && parentFolderKey) {
        const parentExists = await uploadFolderExists(ctx, provider, mountPoint, parentFolderKey);
        if (!parentExists) {
          throw new Error("Parent directory does not exist.");
        }
      }

      const foldersToCreate = options?.recursive ? getAncestorFolderKeys(folderKey) : [folderKey];
      for (const ancestorFolderKey of foldersToCreate) {
        await ensureUploadDirectoryMarker(ctx, provider, ancestorFolderKey);
      }
    },
    async rm(path, options) {
      const { fileKey, isRoot, isDirectoryPath } = toRelativeUploadPath(mountPoint, path);

      if (isRoot) {
        if (!options?.recursive) {
          throw new Error("Folder deletion requires recursive=true.");
        }

        const files = await listAllUploadFiles(ctx, provider);
        await Promise.all(files.map((file) => deleteUploadRecord(ctx, file)));
        return;
      }

      if (!fileKey) {
        if (options?.force) {
          return;
        }
        throw new Error("File not found.");
      }

      const directFile = !isDirectoryPath
        ? await fetchUploadFileFromRuntime(ctx, provider, fileKey)
        : null;
      if (directFile && !isUploadDirectoryMarker(directFile)) {
        await deleteUploadRecord(ctx, directFile);
        return;
      }

      const prefix = ensureFolderPrefix(fileKey);
      const files = await listAllUploadFiles(ctx, provider);
      const matches = files.filter((file) => file.fileKey.startsWith(prefix));

      if (matches.length === 0) {
        if (options?.force) {
          return;
        }
        throw new Error("File not found.");
      }

      if (!options?.recursive) {
        throw new Error("Folder deletion requires recursive=true.");
      }

      await Promise.all(matches.map((file) => deleteUploadRecord(ctx, file)));
    },
    async chmod(path, mode) {
      const target = await resolveUploadMetadataMutationTarget(
        this,
        ctx,
        provider,
        mountPoint,
        path,
        "chmod",
      );
      await updateUploadRecord(ctx, target, {
        metadata: mergeUploadFsMetadata(target.metadata, {
          mode: normalizeUploadMode(mode),
        }),
      });
    },
    async utimes(path, _atime, mtime) {
      const target = await resolveUploadMetadataMutationTarget(
        this,
        ctx,
        provider,
        mountPoint,
        path,
        "utimes",
      );
      const normalizedMtime = normalizeUploadMtime(mtime, path);
      await updateUploadRecord(ctx, target, {
        metadata: mergeUploadFsMetadata(target.metadata, {
          mtime: normalizedMtime,
        }),
      });
    },
    getAllPaths() {
      return [mountPoint];
    },
  });
};

export type ResolveUploadFileMountOptions = {
  mountPoint?: string;
  provider?: UploadProvider | null;
};

export const resolveUploadFileMount = (
  uploadConfig?: UploadAdminConfigResponse | null,
  options: ResolveUploadFileMountOptions = {},
): FileMountMetadata | null => {
  if (!isUploadConfigured(uploadConfig) && !options.provider) {
    return null;
  }

  const provider =
    options.provider !== undefined && options.provider !== null
      ? resolveBoundUploadProvider(uploadConfig, options.provider)
      : resolvePreferredUploadProvider(uploadConfig);
  if (!provider) {
    return null;
  }

  const configuredProviders = getConfiguredUploadProviders(uploadConfig);

  return {
    ...uploadFileMount,
    mountPoint: normalizeAbsolutePath(options.mountPoint ?? uploadFileMount.mountPoint),
    uploadProvider: provider,
    description: describeUploadRoot(provider, configuredProviders),
  };
};

export const getConfiguredUploadProviders = (
  uploadConfig?: UploadAdminConfigResponse | null,
): UploadProvider[] => {
  if (!uploadConfig) {
    return [];
  }

  const providers: UploadProvider[] = [];

  if (uploadConfig.providers[UPLOAD_PROVIDER_R2_BINDING]?.configured) {
    providers.push(UPLOAD_PROVIDER_R2_BINDING);
  }

  if (uploadConfig.providers[UPLOAD_PROVIDER_R2]?.configured) {
    providers.push(UPLOAD_PROVIDER_R2);
  }

  return providers;
};

export const isUploadConfigured = (
  uploadConfig?: UploadAdminConfigResponse | null,
): uploadConfig is UploadAdminConfigResponse => {
  if (!uploadConfig?.configured) {
    return false;
  }

  return getConfiguredUploadProviders(uploadConfig).length > 0;
};

export const resolvePreferredUploadProvider = (
  uploadConfig?: UploadAdminConfigResponse | null,
): UploadProvider | null => {
  if (!isUploadConfigured(uploadConfig)) {
    return null;
  }

  const defaultProvider = uploadConfig.defaultProvider;
  if (defaultProvider && uploadConfig.providers[defaultProvider]?.configured) {
    return defaultProvider;
  }

  return getConfiguredUploadProviders(uploadConfig)[0] ?? null;
};

export const resolveBoundUploadProvider = (
  uploadConfig?: UploadAdminConfigResponse | null,
  requestedProvider?: UploadProvider | null,
): UploadProvider => {
  const provider = requestedProvider ?? resolvePreferredUploadProvider(uploadConfig);
  if (!provider) {
    throw new Error("Upload is not configured for this organisation.");
  }

  if (!uploadConfig?.providers[provider]?.configured) {
    throw new Error(`Upload provider '${provider}' is not configured.`);
  }

  return provider;
};

export type ResolveUploadMountConfigOptions = {
  provider?: UploadProvider | null;
};

export const resolveUploadMountConfig = (
  uploadConfig?: UploadAdminConfigResponse | null,
  options: ResolveUploadMountConfigOptions = {},
) => {
  const provider =
    options.provider !== undefined && options.provider !== null
      ? resolveBoundUploadProvider(uploadConfig, options.provider)
      : resolvePreferredUploadProvider(uploadConfig);
  if (!provider || provider !== UPLOAD_PROVIDER_R2) {
    return null;
  }

  const providerConfig = uploadConfig?.providers[provider];
  if (!providerConfig?.configured || !providerConfig.config) {
    return null;
  }

  const bucket = providerConfig.config.bucket;
  const endpoint = providerConfig.config.endpoint;
  if (!bucket || !endpoint) {
    return null;
  }

  return {
    bucket,
    options: {
      endpoint,
      pathStyle: providerConfig.config.pathStyle,
      region: providerConfig.config.region ?? undefined,
      provider,
    },
  };
};

const deleteUploadRecord = async (ctx: FilesContext, file: UploadFileRecord) => {
  const response = await requestUpload(ctx, "DELETE", "/files/by-key", {
    query: {
      provider: file.provider,
      key: file.fileKey,
    },
  });

  if (!response.ok) {
    throw new Error(await readResponseMessage(response, "Unable to delete file."));
  }
};

const updateUploadRecord = async (
  ctx: FilesContext,
  file: UploadFileRecord,
  payload: {
    filename?: string;
    visibility?: string | null;
    tags?: string[] | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<UploadFileRecord> => {
  const response = await requestUpload(ctx, "PATCH", "/files/by-key", {
    query: {
      provider: file.provider,
      key: file.fileKey,
    },
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await readResponseMessage(response, "Unable to update file metadata."));
  }

  return (await response.json()) as UploadFileRecord;
};

const fetchUploadFileFromRuntime = async (
  ctx: FilesContext,
  provider: UploadProvider,
  fileKey: string,
): Promise<UploadFileRecord | null> => {
  const response = await requestUpload(ctx, "GET", "/files/by-key", {
    query: {
      provider,
      key: fileKey,
    },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(await readResponseMessage(response, "Failed to load file."));
  }

  const file = (await response.json()) as UploadFileRecord;
  if (file.status === "deleted") {
    return null;
  }

  return file;
};

const listAllUploadFiles = async (
  ctx: FilesContext,
  provider: UploadProvider,
): Promise<UploadFileRecord[]> => {
  const files: UploadFileRecord[] = [];
  let cursor: string | undefined;

  while (true) {
    const response = await requestUpload(ctx, "GET", "/files", {
      query: {
        provider,
        pageSize: "200",
        status: "ready",
        ...(cursor ? { cursor } : {}),
      },
    });

    if (!response.ok) {
      throw new Error(await readResponseMessage(response, "Failed to list files."));
    }

    const payload = (await response.json()) as {
      files?: UploadFileRecord[];
      cursor?: string;
      hasNextPage?: boolean;
    };

    files.push(...(payload.files ?? []).filter((entry) => entry.status !== "deleted"));

    if (!payload.hasNextPage || !payload.cursor) {
      break;
    }

    cursor = payload.cursor;
  }

  return files;
};

type UploadFsMetadata = {
  mode?: number;
  mtime?: string;
};

const readUploadFsMetadata = (
  metadata: Record<string, unknown> | null | undefined,
): UploadFsMetadata => {
  if (!metadata || typeof metadata !== "object") {
    return {};
  }

  const raw = metadata[UPLOAD_FS_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const rawMetadata = raw as Record<string, unknown>;
  const mode = typeof rawMetadata.mode === "number" ? rawMetadata.mode : undefined;
  const mtime =
    typeof rawMetadata.mtime === "string" && !Number.isNaN(Date.parse(rawMetadata.mtime))
      ? rawMetadata.mtime
      : undefined;

  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(mtime ? { mtime } : {}),
  };
};

const readUploadMode = (file: { metadata?: Record<string, unknown> | null }) =>
  readUploadFsMetadata(file.metadata).mode;

const toIsoString = (value?: string | Date | null): string | null => {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const readUploadMtime = (file: {
  metadata?: Record<string, unknown> | null;
  updatedAt?: string | Date | null;
}) => readUploadFsMetadata(file.metadata).mtime ?? toIsoString(file.updatedAt) ?? null;

const mergeUploadFsMetadata = (
  metadata: Record<string, unknown> | null | undefined,
  patch: UploadFsMetadata,
): Record<string, unknown> | null => {
  const nextMetadata = {
    ...metadata,
  } satisfies Record<string, unknown>;
  const currentFsMetadata = readUploadFsMetadata(metadata);
  const nextFsMetadata = {
    ...currentFsMetadata,
    ...patch,
  } satisfies UploadFsMetadata;

  const cleanedFsMetadata = Object.fromEntries(
    Object.entries(nextFsMetadata).filter(([, value]) => value !== undefined),
  );

  if (Object.keys(cleanedFsMetadata).length === 0) {
    delete nextMetadata[UPLOAD_FS_METADATA_KEY];
  } else {
    nextMetadata[UPLOAD_FS_METADATA_KEY] = cleanedFsMetadata;
  }

  return Object.keys(nextMetadata).length > 0 ? nextMetadata : null;
};

const preserveUploadMetadataForRewrite = (
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null => {
  if (!metadata) {
    return null;
  }

  const nextMetadata = {
    ...metadata,
  } satisfies Record<string, unknown>;
  const currentFsMetadata = readUploadFsMetadata(metadata);
  const nextFsMetadata = (
    currentFsMetadata.mode !== undefined ? { mode: currentFsMetadata.mode } : {}
  ) satisfies UploadFsMetadata;

  if (Object.keys(nextFsMetadata).length === 0) {
    delete nextMetadata[UPLOAD_FS_METADATA_KEY];
  } else {
    nextMetadata[UPLOAD_FS_METADATA_KEY] = nextFsMetadata;
  }

  return Object.keys(nextMetadata).length > 0 ? nextMetadata : null;
};

const normalizeUploadMode = (mode: number): number => mode & 0o7777;

const normalizeUploadMtime = (mtime: Date, path: string): string => {
  if (Number.isNaN(mtime.getTime())) {
    throw createInvalidArgumentFileSystemError("utimes", path);
  }

  return mtime.toISOString();
};

const resolveUploadMetadataMutationTarget = async (
  fs: Pick<MountedFileSystem, "describeEntry">,
  ctx: FilesContext,
  provider: UploadProvider,
  mountPoint: string,
  path: string,
  operation: "chmod" | "utimes",
): Promise<UploadFileRecord> => {
  const normalizedPath = path.endsWith("/") ? ensureFolderPath(path) : stripTrailingSlash(path);
  if (stripTrailingSlash(normalizedPath) === mountPoint) {
    throw createUnsupportedOperationFileSystemError(operation, normalizedPath);
  }

  const descriptor = await fs.describeEntry?.(path);
  if (!descriptor) {
    throw createPathNotFoundFileSystemError(operation, normalizedPath);
  }

  const { fileKey } = toRelativeUploadPath(mountPoint, normalizedPath);
  if (!fileKey) {
    throw createUnsupportedOperationFileSystemError(operation, normalizedPath);
  }

  if (descriptor.kind === "file") {
    const file = await fetchUploadFileFromRuntime(ctx, provider, fileKey);
    if (!file || isUploadDirectoryMarker(file)) {
      throw createPathNotFoundFileSystemError(operation, normalizedPath);
    }
    return file;
  }

  if (!(await uploadFolderExists(ctx, provider, mountPoint, fileKey))) {
    throw createPathNotFoundFileSystemError(operation, normalizedPath);
  }

  await ensureUploadDirectoryMarker(ctx, provider, fileKey);
  const marker = await fetchUploadFileFromRuntime(
    ctx,
    provider,
    toUploadDirectoryMarkerFileKey(fileKey),
  );
  if (!marker || !isUploadDirectoryMarker(marker)) {
    throw createPathNotFoundFileSystemError(operation, normalizedPath);
  }

  return marker;
};

const uploadFolderExists = async (
  ctx: FilesContext,
  provider: UploadProvider,
  mountPoint: string,
  folderKey: string,
): Promise<boolean> => {
  if (!folderKey) {
    return true;
  }

  const tree = buildUploadTree(mountPoint, await listAllUploadFiles(ctx, provider));
  return (
    findEntry(tree, ensureFolderPath(`${mountPoint}/${stripLeadingSlash(folderKey)}`))?.kind ===
    "folder"
  );
};

const ensureUploadDirectoryMarker = async (
  ctx: FilesContext,
  provider: UploadProvider,
  folderKey: string,
): Promise<void> => {
  if (!folderKey) {
    return;
  }

  const markerFileKey = toUploadDirectoryMarkerFileKey(folderKey);
  const existing = await fetchUploadFileFromRuntime(ctx, provider, markerFileKey);
  if (existing) {
    if (isUploadDirectoryMarker(existing)) {
      return;
    }

    throw new Error(
      `Cannot create folder '${folderKey}' because its reserved marker path is already in use.`,
    );
  }

  const marker = new File([new Uint8Array()], getUploadDirectoryMarkerFilename(), {
    type: "application/x.fragno-directory-marker",
  });
  const form = new FormData();
  form.set("file", marker);
  form.set("provider", provider);
  form.set("fileKey", markerFileKey);
  form.set("filename", getUploadDirectoryMarkerFilename());
  form.set("metadata", JSON.stringify(createUploadDirectoryMarkerMetadata()));

  const response = await requestUpload(ctx, "POST", "/files", { body: form });
  if (!response.ok) {
    throw new Error(await readResponseMessage(response, "Unable to create upload-backed folder."));
  }
};

const buildUploadTree = (mountPoint: string, files: UploadFileRecord[]): FileEntryDescriptor[] => {
  const folderMap = new Map<string, FileEntryDescriptor & { children: FileEntryDescriptor[] }>();
  const roots: FileEntryDescriptor[] = [];

  const ensureFolder = (
    absolutePath: string,
    title: string,
  ): FileEntryDescriptor & { children: FileEntryDescriptor[] } => {
    const normalizedPath = ensureFolderPath(absolutePath);
    const existing = folderMap.get(normalizedPath);
    if (existing) {
      return existing;
    }

    const folder = {
      kind: "folder" as const,
      path: normalizedPath,
      title,
      children: [],
      fs: {},
    };
    folderMap.set(normalizedPath, folder);

    const parentPath = getParentFolderPath(normalizedPath, mountPoint);
    if (!parentPath) {
      roots.push(folder);
      return folder;
    }

    ensureFolder(parentPath, getLeafSegment(stripTrailingSlash(parentPath))).children.push(folder);
    return folder;
  };

  for (const file of files) {
    if (isUploadDirectoryMarker(file)) {
      const folderKey = getUploadDirectoryMarkerFolderKey(file.fileKey);
      if (!folderKey) {
        continue;
      }

      const folderPath = `${mountPoint}/${folderKey}`;
      const folder = ensureFolder(folderPath, getLeafSegment(stripTrailingSlash(folderPath)));
      const folderMtime = readUploadMtime(file);
      if (folderMtime) {
        folder.updatedAt = folderMtime;
        folder.fs = {
          ...folder.fs,
          mtime: folderMtime,
        };
      }

      const folderMode = readUploadMode(file);
      if (folderMode !== undefined) {
        folder.fs = {
          ...folder.fs,
          mode: folderMode,
        };
      }
      continue;
    }

    const segments = file.fileKey.split("/").filter(Boolean);
    if (segments.length === 0) {
      continue;
    }

    if (segments.length > 1) {
      const folderPath = `${mountPoint}/${segments.slice(0, -1).join("/")}`;
      ensureFolder(folderPath, segments[segments.length - 2] ?? "folder");
    }

    const descriptor = toFileDescriptor(mountPoint, file);
    const parentPath = getParentFolderPath(descriptor.path, mountPoint);
    if (!parentPath) {
      roots.push(descriptor);
      continue;
    }

    ensureFolder(parentPath, getLeafSegment(stripTrailingSlash(parentPath))).children.push(
      descriptor,
    );
  }

  return sortTree(roots);
};

const toFileDescriptor = (
  mountPoint: string,
  file: UploadFileRecord,
  previewUrl?: string,
): FileEntryDescriptor => ({
  kind: "file",
  path: `${mountPoint}/${file.fileKey}`,
  title: file.filename || getLeafSegment(file.fileKey),
  sizeBytes: file.sizeBytes,
  contentType: resolveUploadContentType(file),
  updatedAt: readUploadMtime(file),
  fs: {
    mode: readUploadMode(file),
    mtime: readUploadMtime(file),
  },
  metadata: {
    provider: file.provider,
    fileKey: file.fileKey,
    filename: file.filename,
    status: file.status,
    visibility: file.visibility ?? null,
    uploadId: file.uploadId ?? null,
    uploaderId: file.uploaderId ?? null,
    createdAt: file.createdAt ?? null,
    ...(previewUrl ? { previewUrl } : {}),
  },
});

const findEntry = (entries: FileEntryDescriptor[], path: string): FileEntryDescriptor | null => {
  for (const entry of entries) {
    if (normalizePath(entry.path, entry.kind) === normalizePath(path, entry.kind)) {
      return entry;
    }
    if (entry.kind === "folder" && entry.children?.length) {
      const match = findEntry(entry.children, path);
      if (match) {
        return match;
      }
    }
  }

  return null;
};

const sortTree = (entries: FileEntryDescriptor[]): FileEntryDescriptor[] => {
  return entries
    .map((entry) => ({
      ...entry,
      children: entry.children ? sortTree(entry.children) : undefined,
    }))
    .sort((left, right) => {
      const leftOrder = left.kind === "folder" ? 0 : 1;
      const rightOrder = right.kind === "folder" ? 0 : 1;
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      return (left.title ?? left.path).localeCompare(right.title ?? right.path);
    });
};

const requireUploadRuntime = (ctx: FilesContext) => {
  if (!ctx.uploadRuntime) {
    throw new Error(
      "Upload contributor requires uploadRuntime to be provided via createOrgFileSystem.",
    );
  }

  return ctx.uploadRuntime;
};

const requestUpload = async (
  ctx: FilesContext,
  method: string,
  path: string,
  options: {
    query?: Record<string, string>;
    body?: BodyInit | null;
    headers?: HeadersInit;
  } = {},
): Promise<Response> => {
  const runtime = requireUploadRuntime(ctx);
  const url = new URL(
    `/api/upload${path}`,
    runtime.baseUrl ?? ctx.origin ?? "https://files.internal",
  );

  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const headers = runtime.headers ? new Headers(runtime.headers) : new Headers();
  for (const [key, value] of new Headers(options.headers)) {
    headers.set(key, value);
  }
  if (options.body instanceof FormData) {
    headers.delete("content-type");
  }

  return runtime.fetch(
    new Request(url, {
      method,
      headers,
      body: options.body ?? undefined,
    }),
  );
};

const readResponseMessage = async (response: Response, fallback: string): Promise<string> => {
  try {
    const payload = (await response.clone().json()) as { message?: unknown };
    if (typeof payload.message === "string" && payload.message.trim()) {
      return payload.message;
    }
  } catch {
    // ignore JSON parsing failures
  }

  return fallback;
};

const buildUploadContentUrl = (ctx: FilesContext, file: UploadFileRecord): string | undefined => {
  if (!ctx.request) {
    return undefined;
  }

  const requestUrl = new URL(`/api/upload/${ctx.orgId}/files/by-key/content`, ctx.request.url);
  requestUrl.searchParams.set("provider", file.provider);
  requestUrl.searchParams.set("key", file.fileKey);
  return requestUrl.toString();
};

const createRootStat = (): FsStat => ({
  isFile: false,
  isDirectory: true,
  isSymbolicLink: false,
  mode: DEFAULT_FOLDER_MODE,
  size: 0,
  mtime: UNKNOWN_MTIME,
});

const toFsStat = (entry: FileEntryDescriptor, readOnly: boolean): FsStat => ({
  isFile: entry.kind === "file",
  isDirectory: entry.kind === "folder",
  isSymbolicLink: false,
  mode:
    entry.fs?.mode ??
    (entry.kind === "folder"
      ? readOnly
        ? 0o555
        : DEFAULT_FOLDER_MODE
      : readOnly
        ? 0o444
        : DEFAULT_FILE_MODE),
  size: entry.kind === "file" ? (entry.sizeBytes ?? 0) : 0,
  mtime: entry.fs?.mtime
    ? new Date(entry.fs.mtime)
    : entry.updatedAt
      ? new Date(entry.updatedAt)
      : UNKNOWN_MTIME,
});

const inferUploadContentTypeFromFileKey = (fileKey: string): string | null => {
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

  return null;
};

const isGenericBinaryContentType = (contentType: string | null | undefined): boolean => {
  const normalizedContentType = contentType?.trim().toLowerCase() ?? "";
  return (
    normalizedContentType === "application/octet-stream" ||
    normalizedContentType === "binary/octet-stream"
  );
};

const resolveUploadContentType = (
  file: Pick<UploadFileRecord, "fileKey"> & {
    contentType: string | null | undefined;
  },
): string | null => {
  const inferredContentType = inferUploadContentTypeFromFileKey(file.fileKey);

  if (file.contentType && !isGenericBinaryContentType(file.contentType)) {
    return file.contentType;
  }

  return inferredContentType ?? file.contentType ?? null;
};

const toRelativeUploadPath = (
  mountPoint: string,
  path: string,
): {
  fileKey: string;
  isRoot: boolean;
  isDirectoryPath: boolean;
} => {
  const normalizedPath = normalizeAbsolutePath(path);
  const normalizedRoot = normalizeAbsolutePath(mountPoint);

  if (normalizedPath === normalizedRoot) {
    return {
      fileKey: "",
      isRoot: true,
      isDirectoryPath: true,
    };
  }

  if (!normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return {
      fileKey: "",
      isRoot: false,
      isDirectoryPath: path.endsWith("/"),
    };
  }

  const fileKey = stripLeadingSlash(normalizedPath.slice(normalizedRoot.length));
  return {
    fileKey: stripTrailingSlash(fileKey),
    isRoot: false,
    isDirectoryPath: path.endsWith("/"),
  };
};

const getParentUploadFileKey = (fileKey: string): string => {
  const segments = fileKey.split("/").filter(Boolean);
  return segments.slice(0, -1).join("/");
};

const getAncestorFolderKeys = (folderKey: string): string[] => {
  const segments = folderKey.split("/").filter(Boolean);
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
};

const toBlob = (content: FileContent, contentType: string | null): Blob => {
  const bytes =
    content instanceof Uint8Array ? new Uint8Array(content) : TEXT_ENCODER.encode(content);
  return new Blob([bytes], {
    type: contentType ?? "application/octet-stream",
  });
};

const getParentFolderPath = (path: string, mountPoint: string): string | null => {
  const normalized = stripTrailingSlash(path);
  if (normalized === mountPoint) {
    return null;
  }

  const segments = normalized.split("/").filter(Boolean);
  if (segments.length <= 1) {
    return null;
  }

  const parent = `/${segments.slice(0, -1).join("/")}`;
  return parent === mountPoint ? null : ensureFolderPath(parent);
};

const describeUploadRoot = (
  boundProvider: UploadProvider | null,
  configuredProviders: UploadProvider[],
): string => {
  const providerLabel = boundProvider ? toUploadProviderLabel(boundProvider) : null;
  const configuredLabel = configuredProviders.map(toUploadProviderLabel).join(", ");

  if (providerLabel && configuredProviders.length > 1) {
    return `Persistent org-scoped uploads routed through the Upload fragment. Bound provider: ${providerLabel}. Configured providers: ${configuredLabel}.`;
  }

  if (providerLabel) {
    return `Persistent org-scoped uploads routed through the Upload fragment via ${providerLabel}.`;
  }

  return "Persistent org-scoped uploads routed through the Upload fragment.";
};

const toUploadProviderLabel = (provider: UploadProvider): string => {
  if (provider === UPLOAD_PROVIDER_R2_BINDING) {
    return "R2 binding";
  }

  return "R2 credentials";
};

const normalizeAbsolutePath = (value: string): string => {
  const normalized = value.trim().replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  return `/${segments.join("/")}`;
};

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, "");
const stripLeadingSlash = (value: string): string => value.replace(/^\/+/, "");
const ensureFolderPath = (value: string): string => (value.endsWith("/") ? value : `${value}/`);
const ensureFolderPrefix = (value: string): string =>
  value ? `${stripTrailingSlash(value)}/` : "";
const getLeafSegment = (value: string): string => value.split("/").filter(Boolean).at(-1) ?? value;
const normalizePath = (value: string, kind: FileEntryDescriptor["kind"]): string =>
  kind === "folder" ? ensureFolderPath(stripTrailingSlash(value)) : stripTrailingSlash(value);

const isProbablyTextContent = (contentType: string | null | undefined, path: string): boolean => {
  const normalizedContentType = contentType?.toLowerCase() ?? "";
  return (
    normalizedContentType.startsWith("text/") ||
    normalizedContentType === "application/json" ||
    normalizedContentType === "application/ld+json" ||
    normalizedContentType === "application/xml" ||
    normalizedContentType === "application/javascript" ||
    normalizedContentType === "text/typescript" ||
    /\.(md|mdx|txt|json|js|jsx|ts|tsx|css|html|xml|yml|yaml)$/i.test(path)
  );
};
