import type { FileKey } from "./file-key";
import type { FileLinksConfig } from "./file-links";
import type { TextIndexOptions } from "./text-index";

export type FileHookPayload = {
  fileKey: FileKey;
  objectKey?: string;
  uploadId?: string;
  uploaderId?: string | null;
  sizeBytes: number;
  contentType: string;
};

export type UploadTimeoutPayload = {
  uploadId: string;
  fileKey: FileKey;
};

export interface UploadFragmentConfig {
  /** Largest file the fragment stores. Files live in database rows, so keep it within its limits. */
  maxFileBytes: number;
  /** How long an upload session accepts its content. Defaults to one hour. */
  uploadExpiresInSeconds?: number;
  textIndex?: TextIndexOptions;
  /** Enables signed links that read or write files without the integrator's authentication. */
  fileLinks?: FileLinksConfig;

  onFileReady?: (payload: FileHookPayload, idempotencyKey: string) => Promise<void>;
  onUploadFailed?: (payload: FileHookPayload, idempotencyKey: string) => Promise<void>;
  onFileDeleted?: (payload: FileHookPayload, idempotencyKey: string) => Promise<void>;
}

const DEFAULT_UPLOAD_EXPIRES_IN_SECONDS = 60 * 60;

export function uploadExpiresInSeconds(config: UploadFragmentConfig): number {
  return config.uploadExpiresInSeconds ?? DEFAULT_UPLOAD_EXPIRES_IN_SECONDS;
}
