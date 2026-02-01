import { createS3CompatibleStorageAdapter, type S3CompatibleStorageAdapterOptions } from "./s3";

const DEFAULT_MAX_METADATA_BYTES = 8_192;

export type R2StorageAdapterOptions = Omit<
  S3CompatibleStorageAdapterOptions,
  "maxMetadataBytes"
> & {
  maxMetadataBytes?: number;
};

export function createR2StorageAdapter(options: R2StorageAdapterOptions) {
  const maxMetadataBytes = options.maxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES;
  const adapter = createS3CompatibleStorageAdapter({
    ...options,
    maxMetadataBytes,
  });

  return {
    ...adapter,
    name: "r2",
    limits: {
      ...adapter.limits,
      maxMetadataBytes,
    },
  };
}
