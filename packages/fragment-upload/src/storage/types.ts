import type { FileKeyEncoded, FileKeyParts } from "../keys";

export type UploadTransport = "direct" | "proxy";
export type UploadMode = "single" | "multipart";

export interface StorageAdapterCapabilities {
  directUpload: boolean;
  multipartUpload: boolean;
  signedDownload: boolean;
  proxyUpload: boolean;
}

export type UploadChecksum = { algo: "sha256" | "md5"; value: string };

export interface StorageAdapterLimits {
  maxSingleUploadBytes?: number;
  maxMultipartUploadBytes?: number;
  minMultipartPartSizeBytes?: number;
  maxMultipartPartSizeBytes?: number;
  maxMultipartParts?: number;
  maxStorageKeyLengthBytes?: number;
  maxMetadataBytes?: number;
}

export interface StorageAdapterRecommendations {
  uploadExpiresInSeconds?: number;
  signedUrlExpiresInSeconds?: number;
  directUploadThresholdBytes?: number;
  multipartThresholdBytes?: number;
  multipartPartSizeBytes?: number;
}

export interface StorageAdapter {
  name: string;
  capabilities: StorageAdapterCapabilities;
  limits?: StorageAdapterLimits;
  recommendations?: StorageAdapterRecommendations;

  // Build or validate storage key for this adapter (apply storageKeyPrefix)
  resolveStorageKey(input: { fileKey: FileKeyEncoded; fileKeyParts: FileKeyParts }): string;

  // Create an upload session and decide strategy
  initUpload(input: {
    fileKey: FileKeyEncoded;
    fileKeyParts: FileKeyParts;
    sizeBytes: bigint;
    contentType: string;
    checksum?: UploadChecksum | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<{
    strategy: "direct-single" | "direct-multipart" | "proxy";
    storageKey: string;
    storageUploadId?: string;
    partSizeBytes?: number;
    expiresAt: Date;
    uploadUrl?: string;
    uploadHeaders?: Record<string, string>;
  }>;

  // Direct multipart: issue signed URLs for parts
  getPartUploadUrls?(input: {
    storageKey: string;
    storageUploadId: string;
    partNumbers: number[];
    partSizeBytes: number;
  }): Promise<{ partNumber: number; url: string; headers?: Record<string, string> }[]>;

  // Direct multipart: complete multipart upload
  completeMultipartUpload?(input: {
    storageKey: string;
    storageUploadId: string;
    parts: { partNumber: number; etag: string }[];
  }): Promise<{ etag?: string }>;

  // Direct multipart: abort
  abortMultipartUpload?(input: { storageKey: string; storageUploadId: string }): Promise<void>;

  // Proxy upload: consume stream and store object
  writeStream?(input: {
    storageKey: string;
    body: ReadableStream<Uint8Array>;
    contentType?: string | null;
    sizeBytes?: bigint | null;
  }): Promise<{ etag?: string; sizeBytes?: bigint }>;

  // Finalize / verify size or checksum
  finalizeUpload?(input: {
    storageKey: string;
    expectedSizeBytes: bigint;
    checksum?: UploadChecksum | null;
  }): Promise<{ sizeBytes?: bigint; etag?: string }>;

  // Delete
  deleteObject(input: { storageKey: string }): Promise<void>;

  // Downloads
  getDownloadUrl?(input: {
    storageKey: string;
    expiresInSeconds: number;
    contentDisposition?: string;
    contentType?: string;
  }): Promise<{ url: string; headers?: Record<string, string>; expiresAt: Date }>;

  getDownloadStream?(input: { storageKey: string }): Promise<Response>;
}
