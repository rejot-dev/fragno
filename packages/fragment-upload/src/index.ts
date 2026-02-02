import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import { instantiate } from "@fragno-dev/core";
import { uploadFragmentDefinition } from "./definition";
import type { UploadFragmentConfig } from "./config";
import { uploadRoutes } from "./routes";
import { createUploadFragmentClients } from "./client/clients";

export type {
  FileHookPayload,
  UploadFragmentConfig,
  UploadFragmentResolvedConfig,
  UploadTimeoutPayload,
} from "./config";
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
export type {
  CreateUploadAndTransferOptions,
  UploadHelpers,
  UploadProgress,
} from "./client/helpers";

export { uploadRoutes };

export function createUploadFragment(
  config: UploadFragmentConfig,
  options: FragnoPublicConfigWithDatabase,
) {
  return instantiate(uploadFragmentDefinition)
    .withConfig(config)
    .withRoutes(uploadRoutes)
    .withOptions(options)
    .build();
}
export { createUploadFragmentClients };

export { uploadFragmentDefinition } from "./definition";
