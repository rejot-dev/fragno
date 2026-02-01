import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

export type { FileHookPayload, UploadFragmentConfig, UploadFragmentResolvedConfig } from "./config";
export { resolveUploadFragmentConfig } from "./config";
export { uploadSchema } from "./schema";
export type { FileKeyEncoded, FileKeyPart, FileKeyParts } from "./keys";
export { decodeFileKey, encodeFileKey, encodeFileKeyPrefix } from "./keys";
export type {
  StorageAdapter,
  StorageAdapterCapabilities,
  StorageAdapterLimits,
  StorageAdapterRecommendations,
  UploadChecksum,
  UploadMode,
  UploadTransport,
} from "./storage/types";
export { createFilesystemStorageAdapter, type FilesystemStorageAdapterOptions } from "./storage/fs";
export {
  createS3CompatibleStorageAdapter,
  type S3CompatibleStorageAdapterOptions,
  type S3Signer,
  type S3SignerInput,
} from "./storage/s3";
export { createR2StorageAdapter, type R2StorageAdapterOptions } from "./storage/r2";

export function createUploadFragmentClients(_config: FragnoPublicClientConfig = {}) {
  return {} as const;
}
