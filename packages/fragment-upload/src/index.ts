import { createClientBuilder } from "@fragno-dev/core/client";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import { instantiate } from "@fragno-dev/core";
import { uploadFragmentDefinition } from "./definition";
import { fileRoutesFactory } from "./routes/files";
import { uploadRoutesFactory } from "./routes/uploads";
import type { UploadFragmentConfig } from "./config";

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

export const uploadRoutes = [uploadRoutesFactory, fileRoutesFactory] as const;

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

export function createUploadFragmentClients(config: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(uploadFragmentDefinition, config, uploadRoutes);

  return {
    useFiles: builder.createHook("/files"),
    useFile: builder.createHook("/files/:fileKey"),
    useCreateUpload: builder.createMutator("POST", "/uploads"),
    useUploadStatus: builder.createHook("/uploads/:uploadId"),
    useCompleteUpload: builder.createMutator("POST", "/uploads/:uploadId/complete"),
    useAbortUpload: builder.createMutator("POST", "/uploads/:uploadId/abort"),
    useUpdateFile: builder.createMutator("PATCH", "/files/:fileKey"),
    useDeleteFile: builder.createMutator("DELETE", "/files/:fileKey"),
  };
}

export { uploadFragmentDefinition } from "./definition";
