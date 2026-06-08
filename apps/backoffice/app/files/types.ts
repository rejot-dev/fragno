import type { DurableHookQueueOptions, DurableHookQueueResponse } from "@/fragno/durable-hooks";
import type { UploadAdminConfigResponse, UploadProvider } from "@/fragno/upload";

import type { FileContent, IFileSystem } from "./interface";

export const FILE_ROOT_KINDS = ["static", "upload", "custom"] as const;
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
  backend?: FilesBackend;
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
};

export type FileSystemResolution =
  | IFileSystem
  | {
      fs: IFileSystem;
      mount?: Partial<FileMountMetadata>;
    };

export interface FileContributor extends FileMountMetadata, IFileSystem {
  createFileSystem?(
    ctx: FilesContext,
  ): Promise<FileSystemResolution | null> | FileSystemResolution | null;
}

export type ResolvedFileMount = FileMountMetadata & {
  fs: IFileSystem;
};
