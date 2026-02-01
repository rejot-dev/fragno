import type { FileKeyEncoded, FileKeyParts } from "./keys";
import type {
  StorageAdapter,
  StorageAdapterLimits,
  StorageAdapterRecommendations,
} from "./storage/types";

export type FileHookPayload = {
  fileKey: FileKeyEncoded;
  fileKeyParts: FileKeyParts;
  uploadId?: string;
  uploaderId?: string | null;
  sizeBytes: number;
  contentType: string;
};

export interface UploadFragmentConfig {
  storage: StorageAdapter;
  storageKeyPrefix?: string;
  directUploadThresholdBytes?: number;
  multipartThresholdBytes?: number;
  multipartPartSizeBytes?: number;
  uploadExpiresInSeconds?: number;
  signedUrlExpiresInSeconds?: number;
  maxSingleUploadBytes?: number;
  maxMultipartUploadBytes?: number;

  onFileReady?: (payload: FileHookPayload, idempotencyKey: string) => Promise<void>;
  onUploadFailed?: (payload: FileHookPayload, idempotencyKey: string) => Promise<void>;
  onFileDeleted?: (payload: FileHookPayload, idempotencyKey: string) => Promise<void>;
}

export type UploadFragmentResolvedConfig = Omit<UploadFragmentConfig, "storageKeyPrefix"> & {
  storageKeyPrefix: string;
  signedUrlExpiresInSeconds: number;
};

const DEFAULT_SIGNED_URL_EXPIRES_IN_SECONDS = 60 * 60;

const resolveLimits = (adapter: StorageAdapter): StorageAdapterLimits => adapter.limits ?? {};

const resolveRecommendations = (adapter: StorageAdapter): StorageAdapterRecommendations =>
  adapter.recommendations ?? {};

export const resolveUploadFragmentConfig = (
  config: UploadFragmentConfig,
): UploadFragmentResolvedConfig => {
  const limits = resolveLimits(config.storage);
  const recommendations = resolveRecommendations(config.storage);

  const maxSingleUploadBytes = config.maxSingleUploadBytes ?? limits.maxSingleUploadBytes;
  const maxMultipartUploadBytes = config.maxMultipartUploadBytes ?? limits.maxMultipartUploadBytes;

  return {
    ...config,
    storageKeyPrefix: config.storageKeyPrefix ?? "",
    uploadExpiresInSeconds: config.uploadExpiresInSeconds ?? recommendations.uploadExpiresInSeconds,
    signedUrlExpiresInSeconds:
      config.signedUrlExpiresInSeconds ??
      recommendations.signedUrlExpiresInSeconds ??
      DEFAULT_SIGNED_URL_EXPIRES_IN_SECONDS,
    maxSingleUploadBytes,
    maxMultipartUploadBytes,
    multipartPartSizeBytes:
      config.multipartPartSizeBytes ??
      recommendations.multipartPartSizeBytes ??
      limits.minMultipartPartSizeBytes,
    directUploadThresholdBytes:
      config.directUploadThresholdBytes ??
      recommendations.directUploadThresholdBytes ??
      maxSingleUploadBytes,
    multipartThresholdBytes:
      config.multipartThresholdBytes ??
      recommendations.multipartThresholdBytes ??
      maxSingleUploadBytes,
  };
};
