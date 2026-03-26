import type { RouterContextProvider } from "react-router";

import type { DurableHookQueueOptions, DurableHookQueueResponse } from "@/fragno/durable-hooks";
import type { UploadAdminConfigResponse, UploadProvider } from "@/fragno/upload";

import type { DirentEntry, FsStat, FileContent, IFileSystem } from "./interface";

export const FILE_ROOT_KINDS = ["static", "starter", "upload", "custom"] as const;
export type FileRootKind = (typeof FILE_ROOT_KINDS)[number];

export const FILE_ROOT_PERSISTENCE = ["ephemeral", "persistent", "session"] as const;
export type FileRootPersistence = (typeof FILE_ROOT_PERSISTENCE)[number];

export const FILE_BACKEND = ["backoffice", "pi", "sandbox"] as const;
export type FilesBackend = (typeof FILE_BACKEND)[number];

export const FILE_ENTRY_KINDS = ["file", "folder"] as const;
export type FileEntryKind = (typeof FILE_ENTRY_KINDS)[number];

export type FileSystemArtifact = FileContent;

/**
 * Static metadata for a mounted filesystem.
 *
 * This describes where a filesystem is mounted and how higher layers should present it.
 * The metadata is intentionally independent from the runtime filesystem instance so the
 * master router can synthesize virtual parent directories and expose stable mount info.
 */
export type FileMountMetadata = {
  id: string;
  kind: FileRootKind;
  mountPoint: string;
  title: string;
  readOnly: boolean;
  persistence: FileRootPersistence;
  description?: string;
  uploadProvider?: UploadProvider;
};

export type FileEntryDescriptor = {
  kind: FileEntryKind;
  path: string;
  title?: string;
  sizeBytes?: number | null;
  contentType?: string | null;
  updatedAt?: string | Date | null;
  metadata?: Record<string, unknown> | null;
  fs?: {
    mode?: number | null;
    mtime?: string | Date | null;
  };
  children?: FileEntryDescriptor[];
};

export type FilesContext = {
  orgId: string;
  origin?: string;
  backend: FilesBackend;
  uploadConfig?: UploadAdminConfigResponse | null;
  uploadRuntime?: {
    baseUrl?: string;
    headers?: HeadersInit;
    fetch(request: Request): Promise<Response>;
  };
  resendRuntime?: {
    baseUrl?: string;
    headers?: HeadersInit;
    fetch(request: Request): Promise<Response>;
  };
  durableHooksRuntimes?: Array<{
    contributorId: string;
    getHookQueue(options?: DurableHookQueueOptions): Promise<DurableHookQueueResponse>;
  }>;
  request?: Request;
  routerContext?: Readonly<RouterContextProvider>;
};

export type MountedFileSystemCapabilities = {
  writeFile: boolean;
  mkdir: boolean;
  rm: boolean;
};

/**
 * Fully-resolved filesystem contract exposed by mounted filesystems.
 *
 * Resolved mounts always provide the full filesystem surface. Operations that a mount cannot
 * support must throw when called. Higher layers should use `capabilities` when they need to know
 * whether a mount supports a user-facing mutation without probing by calling the method.
 *
 * getAllPaths() is advisory: implementations may return a sparse subset of known paths and callers
 * must not rely on the result being exhaustive.
 */
export interface MountedFileSystem extends IFileSystem {
  readdirWithFileTypes(path: string): Promise<DirentEntry[]>;
  capabilities: MountedFileSystemCapabilities;
  describeEntry?(
    path: string,
    stat?: FsStat | null,
  ): Promise<FileEntryDescriptor | null> | FileEntryDescriptor | null;
}

/**
 * Author-facing mounted filesystem input.
 *
 * Individual mounts may provide only the operations they can implement directly. The master router
 * normalizes these partial inputs into a full MountedFileSystem by supplying generic fallbacks and
 * throwing implementations for unsupported methods.
 */
export interface MountedFileSystemInput extends Partial<IFileSystem> {
  readdirWithFileTypes?(path: string): Promise<DirentEntry[]>;
  capabilities?: Partial<MountedFileSystemCapabilities>;
  describeEntry?(
    path: string,
    stat?: FsStat | null,
  ): Promise<FileEntryDescriptor | null> | FileEntryDescriptor | null;
}

/**
 * Registered contributor for a single mount.
 *
 * Contributors may implement filesystem methods directly, or provide createFileSystem() when the
 * mounted filesystem must be bound to request/org-specific runtime state.
 */
export type MountedFileSystemResolution =
  | MountedFileSystemInput
  | {
      fs: MountedFileSystemInput;
      mount?: Partial<FileMountMetadata>;
    };

export interface FileContributor extends FileMountMetadata, MountedFileSystemInput {
  createFileSystem?(
    ctx: FilesContext,
  ): Promise<MountedFileSystemResolution | null> | MountedFileSystemResolution | null;
}

export type ResolvedFileMount = FileMountMetadata & {
  fs: MountedFileSystem;
};
