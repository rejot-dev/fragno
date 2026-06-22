import { z } from "zod";

import { BackofficeUnavailableError } from "@/backoffice-runtime/kernel";
import {
  UPLOAD_PROVIDER_DATABASE,
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
import {
  createUnsupportedFileSystem,
  type BufferEncoding,
  type CpOptions,
  type FileContent,
  type FsStat,
  type IFileSystem,
  type WriteFileOptions,
} from "../interface";
import {
  ensureFolderPath,
  normalizeAbsolutePath,
  resolvePath as resolveUploadPath,
  stripTrailingSlash,
} from "../normalize-path";
import {
  ROOT_FILE_NODE_PERMISSIONS,
  ROOT_FILE_PRINCIPAL,
  assertFileOwnerOrRoot,
  assertFileWritable,
  assertRootFilePrincipal,
  isRootFilePrincipal,
  type FileGroup,
  type FilePrincipal,
  type FileSubject,
} from "../permissions";
import type {
  FileContributor,
  FileEntryDescriptor,
  FileMountMetadata,
  FilesContext,
} from "../types";
import {
  createUploadDirectoryMarkerMetadata,
  getUploadDirectoryMarkerFolderKey,
  getUploadDirectoryMarkerFilename,
  isUploadDirectoryMarker,
  toUploadDirectoryMarkerFileKey,
} from "./upload-markers";

const UPLOAD_FILE_MOUNT_ID = "workspace";
const UPLOAD_FILE_MOUNT_POINT = "/workspace";
const UPLOAD_R2_BINDING_FILE_MOUNT_ID = "r2";
const UPLOAD_R2_BINDING_FILE_MOUNT_POINT = "/r2";
const UPLOAD_R2_REMOTE_FILE_MOUNT_ID = "r2-remote";
const UPLOAD_R2_REMOTE_FILE_MOUNT_POINT = "/r2-remote";
const UNKNOWN_MTIME = new Date(0);
const TEXT_ENCODER = new TextEncoder();

type UploadWriteOptions = WriteFileOptions | BufferEncoding | undefined;

const getWriteEncoding = (options: UploadWriteOptions): BufferEncoding | undefined =>
  typeof options === "string" ? options : options?.encoding;

const decodeUploadBytes = (
  bytes: Uint8Array,
  options?: BufferEncoding | { encoding?: BufferEncoding | null },
): string => {
  const encoding = typeof options === "string" ? options : options?.encoding;

  if (encoding === "binary" || encoding === "latin1") {
    return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  }
  if (encoding === "ascii") {
    return Array.from(bytes, (byte) => String.fromCharCode(byte & 0x7f)).join("");
  }
  if (encoding === "hex") {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  if (encoding === "base64") {
    return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
  }

  return new TextDecoder("utf-8").decode(bytes);
};

const binaryStringToBytes = (value: string): Uint8Array => {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return bytes;
};

const toUint8Array = (content: FileContent, options?: UploadWriteOptions): Uint8Array => {
  if (content instanceof Uint8Array) {
    return content;
  }

  const encoding = getWriteEncoding(options);
  return encoding === "binary" || encoding === "latin1"
    ? binaryStringToBytes(content)
    : TEXT_ENCODER.encode(content);
};
const concatBytes = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
};
const UPLOAD_FS_METADATA_KEY = "__docsFs";
const DEFAULT_FILE_MODE = 0o664;
const DEFAULT_FOLDER_MODE = 0o775;
const DEFAULT_MOUNT_ROOT_MODE = 0o775;
const UPLOAD_DIRECTORY_LIST_PAGE_SIZE = "500";
const RESERVED_UPLOAD_DIRECTORY_NAMES = new Set([".fragno"]);

type UploadDirectoryRecord = {
  name: string;
  prefix: string;
  updatedAt?: string | Date | null;
  contentType?: string | null;
  metadata?: Record<string, unknown> | null;
};

const uploadFileMount: FileMountMetadata & {
  uploadProvider: typeof UPLOAD_PROVIDER_DATABASE;
} = {
  id: UPLOAD_FILE_MOUNT_ID,
  kind: "upload",
  mountPoint: UPLOAD_FILE_MOUNT_POINT,
  title: "Workspace",
  readOnly: false,
  persistence: "persistent",
  uploadProvider: UPLOAD_PROVIDER_DATABASE,
  description:
    "Pure persistent org-scoped workspace storage routed through the Upload fragment, with no starter layering or fallback.",
};

const uploadR2BindingFileMount: FileMountMetadata & {
  uploadProvider: typeof UPLOAD_PROVIDER_R2_BINDING;
} = {
  id: UPLOAD_R2_BINDING_FILE_MOUNT_ID,
  kind: "upload",
  mountPoint: UPLOAD_R2_BINDING_FILE_MOUNT_POINT,
  title: "R2",
  readOnly: false,
  persistence: "persistent",
  uploadProvider: UPLOAD_PROVIDER_R2_BINDING,
  description: "Persistent org-scoped uploads routed through the Upload fragment via R2 binding.",
};

const uploadR2RemoteFileMount: FileMountMetadata & {
  uploadProvider: typeof UPLOAD_PROVIDER_R2;
} = {
  id: UPLOAD_R2_REMOTE_FILE_MOUNT_ID,
  kind: "upload",
  mountPoint: UPLOAD_R2_REMOTE_FILE_MOUNT_POINT,
  title: "R2 Keys",
  readOnly: false,
  persistence: "persistent",
  uploadProvider: UPLOAD_PROVIDER_R2,
  description:
    "Persistent org-scoped uploads routed through the Upload fragment via R2 credentials.",
};

const createUploadProviderContributor = (
  mount: FileMountMetadata & { uploadProvider: UploadProvider },
): FileContributor => ({
  ...mount,
  ...createUnsupportedFileSystem(createUnsupportedOperationFileSystemError),
  async createFileSystem(ctx) {
    const uploadConfig = await getUploadConfig(ctx);
    if (!isUploadConfigured(uploadConfig)) {
      return null;
    }

    if (!uploadConfig.providers[mount.uploadProvider]?.configured) {
      return null;
    }

    return {
      fs: createUploadFileSystem(ctx, {
        mountPoint: mount.mountPoint,
        provider: mount.uploadProvider,
      }),
      mount: resolveUploadFileMount(uploadConfig, {
        mountPoint: mount.mountPoint,
        provider: mount.uploadProvider,
      }) ?? {
        ...mount,
      },
    };
  },
});

export const uploadFileContributor = createUploadProviderContributor(uploadFileMount);
export const uploadR2BindingFileContributor =
  createUploadProviderContributor(uploadR2BindingFileMount);
export const uploadR2RemoteFileContributor =
  createUploadProviderContributor(uploadR2RemoteFileMount);

export type CreateUploadFileSystemOptions = {
  mountPoint?: string;
  provider: UploadProvider;
};

const readUploadFileContentResponse = async ({
  ctx,
  provider,
  path,
  fileKey,
  operation,
}: {
  ctx: FilesContext;
  provider: UploadProvider;
  path: string;
  fileKey: string;
  operation: string;
}) => {
  const response = await requestUpload(ctx, "GET", "/files/by-key/content", {
    query: {
      provider,
      key: fileKey,
    },
  });

  if (response.status === 404) {
    throw createPathNotFoundFileSystemError(operation, path);
  }

  if (!response.ok) {
    throw new Error(`Failed to read file (${response.status}).`);
  }

  return response;
};

const normalizeUploadContentType = (contentType: string | null | undefined): string | null => {
  const normalizedContentType = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return normalizedContentType || null;
};

export const createUploadFileSystem = (
  ctx: FilesContext,
  options: CreateUploadFileSystemOptions,
): IFileSystem => {
  const mountPoint = normalizeAbsolutePath(options.mountPoint ?? UPLOAD_FILE_MOUNT_POINT);
  const { provider } = options;

  const getEntry = async (path: string): Promise<FileEntryDescriptor | null> => {
    const normalizedPath = path.endsWith("/") ? ensureFolderPath(path) : stripTrailingSlash(path);
    const relativePath = stripLeadingSlash(stripTrailingSlash(path).slice(mountPoint.length));

    if (!path.endsWith("/") && relativePath) {
      const result = await fetchUploadFileFromRuntime(ctx, provider, relativePath);
      if (result && !isUploadDirectoryMarker(result)) {
        return toFileDescriptor(mountPoint, result, buildUploadContentUrl(ctx, result));
      }
    }

    if (relativePath && (await uploadDirectoryExists(ctx, provider, relativePath))) {
      const marker = await fetchUploadDirectoryMarker(ctx, provider, relativePath);
      const markerMtime = marker ? readUploadMtime(marker) : null;
      const markerMode = marker ? readUploadMode(marker) : undefined;
      return {
        kind: "folder",
        path: ensureFolderPath(normalizedPath),
        title: getLeafSegment(stripTrailingSlash(normalizedPath)),
        updatedAt: markerMtime,
        metadata: marker?.metadata ?? null,
        fs: {
          mode: markerMode,
          mtime: markerMtime,
        },
      };
    }

    return null;
  };

  const fs: IFileSystem = {
    async exists(path) {
      if (stripTrailingSlash(path) === mountPoint) {
        return true;
      }

      return (await getEntry(path)) !== null;
    },
    async stat(path) {
      if (stripTrailingSlash(path) === mountPoint) {
        return createRootStat(ctx);
      }

      const entry = await getEntry(path);
      if (!entry) {
        throw createPathNotFoundFileSystemError("stat", path);
      }

      return toFsStat(entry, false);
    },
    async readdir(path) {
      const entries = await listUploadDirectoryEntries(ctx, provider, mountPoint, path);
      return entries.map((entry) => getLeafSegment(stripTrailingSlash(entry.path)));
    },
    async readdirWithFileTypes(path) {
      const entries = await listUploadDirectoryEntries(ctx, provider, mountPoint, path);
      return entries.map((entry) => ({
        name: getLeafSegment(stripTrailingSlash(entry.path)),
        isFile: entry.kind === "file",
        isDirectory: entry.kind === "folder",
        isSymbolicLink: false,
      }));
    },
    async readFile(path, options) {
      const { fileKey, isRoot, isDirectoryPath } = toRelativeUploadPath(mountPoint, path);
      if (isRoot || !fileKey || isDirectoryPath) {
        throw createPathNotFoundFileSystemError("read", path);
      }

      const response = await readUploadFileContentResponse({
        ctx,
        provider,
        path,
        fileKey,
        operation: "read",
      });

      return decodeUploadBytes(new Uint8Array(await response.arrayBuffer()), options);
    },
    async readFileBuffer(path) {
      const { fileKey, isRoot, isDirectoryPath } = toRelativeUploadPath(mountPoint, path);
      if (isRoot || !fileKey || isDirectoryPath) {
        throw createPathNotFoundFileSystemError("read", path);
      }

      const response = await readUploadFileContentResponse({
        ctx,
        provider,
        path,
        fileKey,
        operation: "read",
      });

      return new Uint8Array(await response.arrayBuffer());
    },
    async readFileStream(path) {
      const { fileKey, isRoot, isDirectoryPath } = toRelativeUploadPath(mountPoint, path);
      if (isRoot || !fileKey || isDirectoryPath) {
        throw createPathNotFoundFileSystemError("read stream", path);
      }

      const response = await readUploadFileContentResponse({
        ctx,
        provider,
        path,
        fileKey,
        operation: "read stream",
      });

      if (!response.body) {
        throw createUnsupportedOperationFileSystemError("read stream", path);
      }

      return response.body;
    },
    async writeFile(path, content, options) {
      const { fileKey, isRoot } = toRelativeUploadPath(mountPoint, path);
      if (isRoot || !fileKey) {
        throw new Error(`Cannot write to the mounted upload root '${mountPoint}'.`);
      }

      const principal = ctx.filePrincipal ?? ROOT_FILE_PRINCIPAL;
      const existing = await fetchUploadFileFromRuntime(ctx, provider, fileKey);
      if (existing && !isUploadDirectoryMarker(existing)) {
        const fsMetadata = readUploadFsMetadata(existing.metadata);
        assertFileWritable({
          principal,
          node: {
            owner: fsMetadata.owner ?? ROOT_FILE_NODE_PERMISSIONS.owner,
            group: fsMetadata.group ?? ROOT_FILE_NODE_PERMISSIONS.group,
            mode: normalizeUploadMode(fsMetadata.mode ?? DEFAULT_FILE_MODE),
          },
          operation: "write",
          path,
        });
      }

      if (!existing) {
        await assertUploadContainingDirectoryWritable(
          ctx,
          provider,
          mountPoint,
          getParentUploadFileKey(fileKey),
          principal,
          "write",
          path,
        );
      }

      for (const folderKey of getAncestorFolderKeys(getParentUploadFileKey(fileKey))) {
        await ensureUploadDirectoryMarker(ctx, provider, folderKey, principal);
      }

      if (existing) {
        await deleteUploadRecord(ctx, existing);
      }

      const blob = toBlob(
        content,
        resolveUploadContentType(existing ?? { fileKey, contentType: null }),
        options,
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
        : mergeUploadFsMetadata(null, {
            owner: principal.subject,
            group: principal.primaryGroup,
            mode: DEFAULT_FILE_MODE,
          });
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

      const principal = ctx.filePrincipal ?? ROOT_FILE_PRINCIPAL;
      await assertUploadContainingDirectoryWritable(
        ctx,
        provider,
        mountPoint,
        getParentUploadFileKey(folderKey),
        principal,
        "mkdir",
        path,
      );
      const foldersToCreate = options?.recursive ? getAncestorFolderKeys(folderKey) : [folderKey];
      for (const ancestorFolderKey of foldersToCreate) {
        await ensureUploadDirectoryMarker(ctx, provider, ancestorFolderKey, principal);
      }
    },
    async rm(path, options) {
      if (options?.recursive) {
        throw createUnsupportedOperationFileSystemError("recursive rm", path);
      }

      const { fileKey, isRoot, isDirectoryPath } = toRelativeUploadPath(mountPoint, path);

      if (isRoot) {
        throw createUnsupportedOperationFileSystemError("rm", path);
      }

      if (!fileKey) {
        if (options?.force) {
          return;
        }
        throw createPathNotFoundFileSystemError("read", path);
      }

      const directFile = !isDirectoryPath
        ? await fetchUploadFileFromRuntime(ctx, provider, fileKey)
        : null;
      const principal = ctx.filePrincipal ?? ROOT_FILE_PRINCIPAL;
      if (directFile && !isUploadDirectoryMarker(directFile)) {
        const fsMetadata = readUploadFsMetadata(directFile.metadata);
        assertFileWritable({
          principal,
          node: {
            owner: fsMetadata.owner ?? ROOT_FILE_NODE_PERMISSIONS.owner,
            group: fsMetadata.group ?? ROOT_FILE_NODE_PERMISSIONS.group,
            mode: normalizeUploadMode(fsMetadata.mode ?? DEFAULT_FILE_MODE),
          },
          operation: "rm",
          path,
        });
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
        throw createPathNotFoundFileSystemError("read", path);
      }

      if (!options?.recursive) {
        throw new Error("Folder deletion requires recursive=true.");
      }

      for (const file of matches) {
        if (!isUploadDirectoryMarker(file)) {
          const fsMetadata = readUploadFsMetadata(file.metadata);
          assertFileWritable({
            principal,
            node: {
              owner: fsMetadata.owner ?? ROOT_FILE_NODE_PERMISSIONS.owner,
              group: fsMetadata.group ?? ROOT_FILE_NODE_PERMISSIONS.group,
              mode: normalizeUploadMode(fsMetadata.mode ?? DEFAULT_FILE_MODE),
            },
            operation: "rm",
            path,
          });
        }
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
      const principal = ctx.filePrincipal ?? ROOT_FILE_PRINCIPAL;
      if (!isRootFilePrincipal(principal)) {
        const fsMetadata = readUploadFsMetadata(target.metadata);
        assertFileOwnerOrRoot({
          principal,
          node: {
            owner: fsMetadata.owner ?? ROOT_FILE_NODE_PERMISSIONS.owner,
            group: fsMetadata.group ?? ROOT_FILE_NODE_PERMISSIONS.group,
            mode: normalizeUploadMode(
              fsMetadata.mode ??
                (isUploadDirectoryMarker(target) ? DEFAULT_FOLDER_MODE : DEFAULT_FILE_MODE),
            ),
          },
          operation: "chmod",
          path,
        });
      }
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
      const fsMetadata = readUploadFsMetadata(target.metadata);
      assertFileWritable({
        principal: ctx.filePrincipal ?? ROOT_FILE_PRINCIPAL,
        node: {
          owner: fsMetadata.owner ?? ROOT_FILE_NODE_PERMISSIONS.owner,
          group: fsMetadata.group ?? ROOT_FILE_NODE_PERMISSIONS.group,
          mode: normalizeUploadMode(fsMetadata.mode ?? DEFAULT_FILE_MODE),
        },
        operation: "utimes",
        path,
      });
      const normalizedMtime = normalizeUploadMtime(mtime, path);
      await updateUploadRecord(ctx, target, {
        metadata: mergeUploadFsMetadata(target.metadata, {
          mtime: normalizedMtime,
        }),
      });
    },
    async chown(path, owner, group) {
      const target = await resolveUploadMetadataMutationTarget(
        this,
        ctx,
        provider,
        mountPoint,
        path,
        "chown",
      );
      assertRootFilePrincipal({
        principal: ctx.filePrincipal ?? ROOT_FILE_PRINCIPAL,
        operation: "chown",
        path,
      });
      await updateUploadRecord(ctx, target, {
        metadata: mergeUploadFsMetadata(target.metadata, {
          owner,
          ...(group ? { group } : {}),
        }),
      });
    },
    async appendFile(path, content, options) {
      const existing = (await fs.exists(path)) ? await fs.readFileBuffer(path) : new Uint8Array();
      const next = concatBytes(existing, toUint8Array(content, options));
      await fs.writeFile(path, next, options);
    },
    async cp(src: string, dest: string, options?: CpOptions) {
      const stat = await fs.stat(src);
      if (stat.isDirectory) {
        if (!options?.recursive) {
          throw createInvalidArgumentFileSystemError("copy", src);
        }
        await fs.mkdir(dest, { recursive: true });
        for (const entry of await fs.readdir(src)) {
          await fs.cp(
            `${stripTrailingSlash(src)}/${entry}`,
            `${stripTrailingSlash(dest)}/${entry}`,
            options,
          );
        }
        return;
      }
      await fs.writeFile(dest, await fs.readFileBuffer(src));
    },
    async mv(src: string, dest: string) {
      await fs.cp(src, dest, { recursive: true });
      await fs.rm(src, { recursive: true, force: true });
    },
    resolvePath: resolveUploadPath,
    getAllPaths() {
      return [mountPoint];
    },
    async symlink(_target: string, linkPath: string) {
      throw createUnsupportedOperationFileSystemError("symlink", linkPath);
    },
    async link(_existingPath: string, newPath: string) {
      throw createUnsupportedOperationFileSystemError("link", newPath);
    },
    async readlink(path: string) {
      throw createUnsupportedOperationFileSystemError("readlink", path);
    },
    async lstat(path: string) {
      return fs.stat(path);
    },
    async realpath(path: string) {
      if (!(await fs.exists(path))) {
        throw createPathNotFoundFileSystemError("realpath", path);
      }
      return stripTrailingSlash(path) || "/";
    },
  };

  return fs;
};

export type ResolveUploadFileMountOptions = {
  mountPoint?: string;
  provider?: UploadProvider | null;
};

const getUploadFileMountForProvider = (provider: UploadProvider): FileMountMetadata => {
  if (provider === UPLOAD_PROVIDER_DATABASE) {
    return uploadFileMount;
  }

  if (provider === UPLOAD_PROVIDER_R2_BINDING) {
    return uploadR2BindingFileMount;
  }

  return uploadR2RemoteFileMount;
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
  const baseMount = getUploadFileMountForProvider(provider);

  return {
    ...baseMount,
    mountPoint: normalizeAbsolutePath(options.mountPoint ?? baseMount.mountPoint),
    uploadProvider: provider,
    description: describeUploadRoot(provider, configuredProviders),
  };
};

const getConfiguredUploadProviders = (
  uploadConfig?: UploadAdminConfigResponse | null,
): UploadProvider[] => {
  if (!uploadConfig) {
    return [];
  }

  const providers: UploadProvider[] = [];

  if (uploadConfig.providers[UPLOAD_PROVIDER_DATABASE]?.configured) {
    providers.push(UPLOAD_PROVIDER_DATABASE);
  }

  if (uploadConfig.providers[UPLOAD_PROVIDER_R2_BINDING]?.configured) {
    providers.push(UPLOAD_PROVIDER_R2_BINDING);
  }

  if (uploadConfig.providers[UPLOAD_PROVIDER_R2]?.configured) {
    providers.push(UPLOAD_PROVIDER_R2);
  }

  return providers;
};

const isUploadConfigured = (
  uploadConfig?: UploadAdminConfigResponse | null,
): uploadConfig is UploadAdminConfigResponse => {
  if (!uploadConfig?.configured) {
    return false;
  }

  return getConfiguredUploadProviders(uploadConfig).length > 0;
};

const resolvePreferredUploadProvider = (
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

const resolveBoundUploadProvider = (
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
        pageSize: UPLOAD_DIRECTORY_LIST_PAGE_SIZE,
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

const uploadDirectoryExists = async (
  ctx: FilesContext,
  provider: UploadProvider,
  folderKey: string,
): Promise<boolean> => {
  const response = await requestUpload(ctx, "GET", "/files", {
    query: {
      provider,
      prefix: ensureFolderPrefix(folderKey),
      delimiter: "/",
      pageSize: "1",
      status: "ready",
    },
  });

  if (!response.ok) {
    throw new Error(await readResponseMessage(response, "Failed to resolve folder."));
  }

  const payload = (await response.json()) as {
    files?: UploadFileRecord[];
    directories?: UploadDirectoryRecord[];
  };

  return Boolean((payload.files?.length ?? 0) > 0 || (payload.directories?.length ?? 0) > 0);
};

const listUploadDirectoryEntries = async (
  ctx: FilesContext,
  provider: UploadProvider,
  mountPoint: string,
  path: string,
): Promise<FileEntryDescriptor[]> => {
  const { fileKey, isRoot } = toRelativeUploadPath(mountPoint, path);
  const prefix = isRoot ? "" : ensureFolderPrefix(fileKey);
  const entries = new Map<string, FileEntryDescriptor>();
  let cursor: string | undefined;

  while (true) {
    const response = await requestUpload(ctx, "GET", "/files", {
      query: {
        provider,
        prefix,
        delimiter: "/",
        pageSize: UPLOAD_DIRECTORY_LIST_PAGE_SIZE,
        status: "ready",
        ...(cursor ? { cursor } : {}),
      },
    });

    if (!response.ok) {
      throw new Error(await readResponseMessage(response, "Failed to list files."));
    }

    const payload = (await response.json()) as {
      files?: UploadFileRecord[];
      directories?: UploadDirectoryRecord[];
      cursor?: string;
      hasNextPage?: boolean;
    };

    for (const directory of payload.directories ?? []) {
      if (isUploadDirectoryMarkerDirectory(directory)) {
        continue;
      }

      const descriptor = toDirectoryDescriptor(mountPoint, directory);
      entries.set(descriptor.path, descriptor);
    }

    for (const file of payload.files ?? []) {
      if (file.status === "deleted" || isUploadDirectoryMarker(file)) {
        continue;
      }

      const descriptor = toFileDescriptor(mountPoint, file, buildUploadContentUrl(ctx, file));
      entries.set(descriptor.path, descriptor);
    }

    if (!payload.hasNextPage || !payload.cursor) {
      break;
    }

    cursor = payload.cursor;
  }

  return Array.from(entries.values()).sort((left, right) => {
    const leftOrder = left.kind === "folder" ? 0 : 1;
    const rightOrder = right.kind === "folder" ? 0 : 1;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    return (left.title ?? left.path).localeCompare(right.title ?? right.path);
  });
};

const fetchUploadDirectoryMarker = async (
  ctx: FilesContext,
  provider: UploadProvider,
  folderKey: string,
): Promise<UploadFileRecord | null> => {
  const marker = await fetchUploadFileFromRuntime(
    ctx,
    provider,
    toUploadDirectoryMarkerFileKey(folderKey),
  );
  return marker && isUploadDirectoryMarker(marker) ? marker : null;
};

const isUploadDirectoryMarkerDirectory = (directory: UploadDirectoryRecord): boolean => {
  if (!RESERVED_UPLOAD_DIRECTORY_NAMES.has(directory.name)) {
    return false;
  }

  const markerKey = `${stripTrailingSlash(directory.prefix)}/${getUploadDirectoryMarkerFilename()}`;
  return isUploadDirectoryMarker({
    fileKey: markerKey,
    contentType: directory.contentType,
    metadata: directory.metadata,
  });
};

type UploadFsMetadata = {
  owner?: FileSubject;
  group?: FileGroup;
  mode?: number;
  mtime?: string;
};

const backofficeContextScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("system") }),
  z.object({ kind: z.literal("org"), orgId: z.string() }),
  z.object({ kind: z.literal("user"), userId: z.string() }),
  z.object({ kind: z.literal("project"), orgId: z.string(), projectId: z.string() }),
]);

const fileSubjectSchema: z.ZodType<FileSubject> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("root") }),
  z.object({ kind: z.literal("user"), userId: z.string() }),
  z.object({
    kind: z.literal("automation"),
    automationId: z.string(),
    scope: backofficeContextScopeSchema,
  }),
  z.object({
    kind: z.literal("object"),
    objectType: z.string(),
    objectId: z.string(),
    scope: backofficeContextScopeSchema,
  }),
]);

const fileGroupSchema: z.ZodType<FileGroup> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("root") }),
  z.object({ kind: z.literal("user"), userId: z.string() }),
  z.object({ kind: z.literal("org"), orgId: z.string() }),
]);

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
  const owner = fileSubjectSchema.safeParse(rawMetadata.owner).data;
  const group = fileGroupSchema.safeParse(rawMetadata.group).data;
  const mode = typeof rawMetadata.mode === "number" ? rawMetadata.mode : undefined;
  const mtime =
    typeof rawMetadata.mtime === "string" && !Number.isNaN(Date.parse(rawMetadata.mtime))
      ? rawMetadata.mtime
      : undefined;

  return {
    ...(owner ? { owner } : {}),
    ...(group ? { group } : {}),
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
  const nextFsMetadata = {
    ...(currentFsMetadata.owner ? { owner: currentFsMetadata.owner } : {}),
    ...(currentFsMetadata.group ? { group: currentFsMetadata.group } : {}),
    ...(currentFsMetadata.mode !== undefined ? { mode: currentFsMetadata.mode } : {}),
  } satisfies UploadFsMetadata;

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

const assertUploadContainingDirectoryWritable = async (
  ctx: FilesContext,
  provider: UploadProvider,
  mountPoint: string,
  folderKey: string,
  principal: FilePrincipal,
  operation: string,
  path: string,
): Promise<void> => {
  const ancestorFolderKeys = getAncestorFolderKeys(folderKey);
  for (let index = ancestorFolderKeys.length - 1; index >= 0; index -= 1) {
    const marker = await fetchUploadDirectoryMarker(ctx, provider, ancestorFolderKeys[index]!);
    if (!marker) {
      continue;
    }

    const fsMetadata = readUploadFsMetadata(marker.metadata);
    assertFileWritable({
      principal,
      node: {
        owner: fsMetadata.owner ?? ROOT_FILE_NODE_PERMISSIONS.owner,
        group: fsMetadata.group ?? ROOT_FILE_NODE_PERMISSIONS.group,
        mode: normalizeUploadMode(fsMetadata.mode ?? DEFAULT_FOLDER_MODE),
      },
      operation,
      path,
    });
    return;
  }

  assertFileWritable({
    principal,
    node: {
      owner: ROOT_FILE_NODE_PERMISSIONS.owner,
      group: principal.primaryGroup,
      mode: DEFAULT_MOUNT_ROOT_MODE,
    },
    operation,
    path: stripTrailingSlash(mountPoint) || path,
  });
};

const resolveUploadMetadataMutationTarget = async (
  fs: Pick<IFileSystem, "stat">,
  ctx: FilesContext,
  provider: UploadProvider,
  mountPoint: string,
  path: string,
  operation: "chmod" | "chown" | "utimes",
): Promise<UploadFileRecord> => {
  const normalizedPath = path.endsWith("/") ? ensureFolderPath(path) : stripTrailingSlash(path);
  if (stripTrailingSlash(normalizedPath) === mountPoint) {
    throw createUnsupportedOperationFileSystemError(operation, normalizedPath);
  }

  const stat = await fs.stat(path);
  const { fileKey } = toRelativeUploadPath(mountPoint, normalizedPath);
  if (!fileKey) {
    throw createUnsupportedOperationFileSystemError(operation, normalizedPath);
  }

  if (stat.isFile) {
    const file = await fetchUploadFileFromRuntime(ctx, provider, fileKey);
    if (!file || isUploadDirectoryMarker(file)) {
      throw createPathNotFoundFileSystemError(operation, normalizedPath);
    }
    return file;
  }

  if (!(await uploadFolderExists(ctx, provider, mountPoint, fileKey))) {
    throw createPathNotFoundFileSystemError(operation, normalizedPath);
  }

  await ensureUploadDirectoryMarker(ctx, provider, fileKey, ROOT_FILE_PRINCIPAL);
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
  principal: FilePrincipal,
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
  form.set(
    "metadata",
    JSON.stringify({
      ...createUploadDirectoryMarkerMetadata(),
      [UPLOAD_FS_METADATA_KEY]: {
        owner: principal.subject,
        group: principal.primaryGroup,
        mode: DEFAULT_FOLDER_MODE,
      },
    }),
  );

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

      const folderFsMetadata = readUploadFsMetadata(file.metadata);
      folder.fs = {
        ...folder.fs,
        ...(folderFsMetadata.owner ? { owner: folderFsMetadata.owner } : {}),
        ...(folderFsMetadata.group ? { group: folderFsMetadata.group } : {}),
        ...(folderFsMetadata.mode !== undefined ? { mode: folderFsMetadata.mode } : {}),
      };
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

const toDirectoryDescriptor = (
  mountPoint: string,
  directory: UploadDirectoryRecord,
): FileEntryDescriptor => {
  const folderKey = stripTrailingSlash(directory.prefix);
  return {
    kind: "folder",
    path: ensureFolderPath(`${mountPoint}/${folderKey}`),
    title: directory.name || getLeafSegment(folderKey),
    updatedAt: directory.updatedAt ?? null,
    metadata: directory.metadata ?? null,
    fs: {
      mode: readUploadFsMetadata(directory.metadata).mode,
      mtime: readUploadFsMetadata(directory.metadata).mtime,
    },
  };
};

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

const getUploadObject = (ctx: FilesContext) => {
  if (!ctx.objects) {
    return null;
  }

  try {
    return ctx.kernel.scoped("UPLOAD", ctx.execution.scope, ctx.objects.upload);
  } catch (error) {
    if (error instanceof BackofficeUnavailableError) {
      return null;
    }
    throw error;
  }
};

const getUploadConfig = async (ctx: FilesContext): Promise<UploadAdminConfigResponse | null> =>
  (await getUploadObject(ctx)?.getAdminConfig()) ?? null;

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
  const uploadObject = getUploadObject(ctx);
  if (!uploadObject) {
    throw new Error("Upload filesystem requires Backoffice objects.");
  }
  const url = new URL(`/api/upload${path}`, ctx.origin ?? "https://files.internal");

  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const headers = new Headers();
  for (const [key, value] of new Headers(options.headers)) {
    headers.set(key, value);
  }
  if (options.body instanceof FormData) {
    headers.delete("content-type");
  }

  return uploadObject.fetch(
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
  if (!ctx.request || ctx.execution.scope.kind !== "org") {
    return undefined;
  }

  const requestUrl = new URL(
    `/api/upload/${ctx.execution.scope.orgId}/files/by-key/content`,
    ctx.request.url,
  );
  requestUrl.searchParams.set("provider", file.provider);
  requestUrl.searchParams.set("key", file.fileKey);
  return requestUrl.toString();
};

const createRootStat = (ctx?: FilesContext): FsStat => ({
  isFile: false,
  isDirectory: true,
  isSymbolicLink: false,
  mode: ctx?.filePrincipal ? DEFAULT_MOUNT_ROOT_MODE : DEFAULT_FOLDER_MODE,
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
  const normalizedContentType = normalizeUploadContentType(contentType) ?? "";
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
  const normalizedContentType = normalizeUploadContentType(file.contentType);

  if (normalizedContentType && !isGenericBinaryContentType(normalizedContentType)) {
    return normalizedContentType;
  }

  return inferredContentType ?? normalizedContentType ?? null;
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

const toBlob = (
  content: FileContent,
  contentType: string | null,
  options?: UploadWriteOptions,
): Blob => {
  const bytes = toUint8Array(content, options);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);

  return new Blob([buffer], {
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
  if (provider === UPLOAD_PROVIDER_DATABASE) {
    return "Database";
  }

  if (provider === UPLOAD_PROVIDER_R2_BINDING) {
    return "R2 binding";
  }

  return "R2 credentials";
};
const stripLeadingSlash = (value: string): string => value.replace(/^\/+/, "");
const ensureFolderPrefix = (value: string): string =>
  value ? `${stripTrailingSlash(value)}/` : "";
const getLeafSegment = (value: string): string => value.split("/").filter(Boolean).at(-1) ?? value;
const normalizePath = (value: string, kind: FileEntryDescriptor["kind"]): string =>
  kind === "folder" ? ensureFolderPath(stripTrailingSlash(value)) : stripTrailingSlash(value);
