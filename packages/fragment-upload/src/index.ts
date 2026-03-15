import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import { createUploadFragmentClients } from "./client/clients";
import type { UploadFragmentConfig } from "./config";
import { uploadFragmentDefinition } from "./definition";
import { uploadRoutes } from "./routes";

export type {
  FileHookPayload,
  UploadFragmentConfig,
  UploadFragmentResolvedConfig,
  UploadTimeoutPayload,
} from "./config";
export { resolveUploadFragmentConfig } from "./config";
export { uploadSchema } from "./schema";
export type { FileKey, FileKeyValidationResult, ValidateFileKeyOptions } from "./file-key";
export { assertFileKey, splitFileKey, validateFileKey } from "./file-key";
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
export {
  createR2BindingStorageAdapter,
  resolveR2BindingBucket,
  type R2BindingBucket,
  type R2BindingStorageAdapterOptions,
} from "./storage/r2-binding";
export type {
  CreateUploadAndTransferOptions,
  DownloadFileOptions,
  DownloadMethod,
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
