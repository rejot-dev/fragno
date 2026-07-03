import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type { DurableHookQueueOptions, DurableHookQueueResponse } from "@/fragno/durable-hooks";
import type { UploadProvider } from "@/fragno/upload";

import type { FileContent, IFileSystem } from "./interface";
import type { FilePrincipal } from "./permissions";

const FILE_ROOT_KINDS = ["static", "upload", "custom"] as const;
export type FileRootKind = (typeof FILE_ROOT_KINDS)[number];

const FILE_ROOT_PERSISTENCE = ["ephemeral", "persistent", "session"] as const;
export type FileRootPersistence = (typeof FILE_ROOT_PERSISTENCE)[number];

const FILE_BACKEND = ["backoffice", "pi", "sandbox"] as const;
export type FilesBackend = (typeof FILE_BACKEND)[number];

const FILE_ENTRY_KINDS = ["file", "folder"] as const;
export type FileEntryKind = (typeof FILE_ENTRY_KINDS)[number];

export type FileSystemArtifact = FileContent;

export type StaticFileArtifactsResolver = () =>
  | Promise<Record<string, FileSystemArtifact>>
  | Record<string, FileSystemArtifact>;

export const emptyStaticFileArtifacts: StaticFileArtifactsResolver = () => ({});

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
  origin?: string;
  backend?: FilesBackend;
  request?: Request;
  objects?: BackofficeObjectRegistry;
  execution: BackofficeExecutionContext;
  kernel: BackofficeKernel;
  filePrincipal: FilePrincipal;
  automationHookQueue?: (options?: DurableHookQueueOptions) => Promise<DurableHookQueueResponse>;
  staticFileArtifacts: StaticFileArtifactsResolver;
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
