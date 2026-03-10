import type { StorageAdapter } from "./types";
import { assertFileKey } from "../file-key";

const BYTES_IN_MIB = 1024 * 1024;
const BYTES_IN_GIB = 1024 * BYTES_IN_MIB;
const DEFAULT_MAX_STORAGE_KEY_LENGTH_BYTES = 1024;
const DEFAULT_UPLOAD_EXPIRES_IN_SECONDS = 60 * 60;
const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const DEFAULT_MIN_MULTIPART_PART_SIZE_BYTES = 5 * BYTES_IN_MIB;
const DEFAULT_MAX_MULTIPART_PART_SIZE_BYTES = 5 * BYTES_IN_GIB;
const DEFAULT_MAX_MULTIPART_PARTS = 10_000;
const DEFAULT_MULTIPART_PART_SIZE_BYTES = 8 * BYTES_IN_MIB;

type R2BindingPutResult = {
  httpEtag?: string;
  etag?: string;
  size?: number;
};

type R2BindingGetResult = {
  body: ReadableStream<Uint8Array> | null;
  size: number;
  httpEtag: string;
  httpMetadata?: {
    contentType?: string;
  };
};

type R2BindingUploadedPart = {
  etag: string;
  partNumber: number;
};

type R2BindingMultipartUpload = {
  uploadId: string;
  uploadPart: (partNumber: number, value: unknown) => Promise<R2BindingUploadedPart>;
  complete: (parts: R2BindingUploadedPart[]) => Promise<R2BindingPutResult>;
  abort: () => Promise<void>;
};

export type R2BindingBucket = {
  put: (
    key: string,
    value: unknown,
    options?: {
      httpMetadata?: {
        contentType?: string;
      };
    },
  ) => Promise<R2BindingPutResult>;
  get: (key: string) => Promise<R2BindingGetResult | null>;
  delete: (key: string) => Promise<void>;
  createMultipartUpload: (
    key: string,
    options?: {
      httpMetadata?: {
        contentType?: string;
      };
    },
  ) => Promise<R2BindingMultipartUpload>;
};

export type R2BindingStorageAdapterOptions = {
  bucket: R2BindingBucket;
  storageKeyPrefix?: string;
  directUploadThresholdBytes?: number;
  multipartThresholdBytes?: number;
  multipartPartSizeBytes?: number;
  uploadExpiresInSeconds?: number;
  signedUrlExpiresInSeconds?: number;
  maxSingleUploadBytes?: number;
  maxMultipartUploadBytes?: number;
  maxStorageKeyLengthBytes?: number;
  maxMetadataBytes?: number;
  defaultContentType?: string;
};

const normalizePrefix = (prefix: string): string => {
  if (!prefix) {
    return "";
  }

  const segments = prefix.split("/").filter(Boolean);
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error("Storage key prefix cannot include '.' or '..' segments");
    }
  }

  return segments.join("/");
};

const normalizeProvider = (provider: string): string => {
  const normalized = provider.trim();
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    normalized.includes("\\")
  ) {
    throw new Error("Invalid provider");
  }

  return normalized;
};

const resolveMetadataSize = (metadata?: Record<string, unknown> | null) => {
  if (!metadata) {
    return 0;
  }

  const serialized = JSON.stringify(metadata);
  return new TextEncoder().encode(serialized).byteLength;
};

const divideCeil = (numerator: bigint, denominator: bigint) =>
  (numerator + denominator - 1n) / denominator;

const resolveEtag = (result: { httpEtag?: string; etag?: string }) =>
  result.httpEtag ?? result.etag;

const assertSizeMatches = (input: { expected?: bigint | null; actual?: bigint | null }) => {
  if (input.expected === undefined || input.expected === null) {
    return;
  }
  if (input.actual === undefined || input.actual === null) {
    return;
  }
  if (input.expected !== input.actual) {
    throw new Error("Upload size mismatch");
  }
};

const normalizeUploadedPart = (
  uploadedPart: unknown,
  fallbackPartNumber: number,
): R2BindingUploadedPart => {
  if (!uploadedPart || typeof uploadedPart !== "object") {
    throw new Error("STORAGE_ERROR");
  }

  const part = uploadedPart as Partial<R2BindingUploadedPart>;
  if (typeof part.etag !== "string" || part.etag.length === 0) {
    throw new Error("STORAGE_ERROR");
  }

  return {
    etag: part.etag,
    partNumber: typeof part.partNumber === "number" ? part.partNumber : fallbackPartNumber,
  };
};

const takeBytesFromChunks = (chunks: Uint8Array[], size: number) => {
  const part = new Uint8Array(size);
  let offset = 0;

  while (offset < size) {
    const chunk = chunks[0];
    if (!chunk) {
      throw new Error("STORAGE_ERROR");
    }

    const remaining = size - offset;
    if (chunk.byteLength <= remaining) {
      part.set(chunk, offset);
      offset += chunk.byteLength;
      chunks.shift();
      continue;
    }

    part.set(chunk.subarray(0, remaining), offset);
    chunks[0] = chunk.subarray(remaining);
    offset += remaining;
  }

  return part;
};

export function createR2BindingStorageAdapter(
  options: R2BindingStorageAdapterOptions,
): StorageAdapter {
  const storageKeyPrefix = normalizePrefix(options.storageKeyPrefix ?? "");
  const maxStorageKeyLengthBytes =
    options.maxStorageKeyLengthBytes ?? DEFAULT_MAX_STORAGE_KEY_LENGTH_BYTES;
  const uploadExpiresInSeconds =
    options.uploadExpiresInSeconds ?? DEFAULT_UPLOAD_EXPIRES_IN_SECONDS;
  const maxSingleUploadBytes = options.maxSingleUploadBytes;
  const maxMultipartUploadBytes = options.maxMultipartUploadBytes;
  const multipartThresholdBytes = options.multipartThresholdBytes ?? maxSingleUploadBytes;
  const multipartPartSizeBytes =
    options.multipartPartSizeBytes ?? DEFAULT_MULTIPART_PART_SIZE_BYTES;
  const minMultipartPartSizeBytes = DEFAULT_MIN_MULTIPART_PART_SIZE_BYTES;
  const maxMultipartPartSizeBytes = DEFAULT_MAX_MULTIPART_PART_SIZE_BYTES;
  const maxMultipartParts = DEFAULT_MAX_MULTIPART_PARTS;
  const maxUploadBytes = options.maxMultipartUploadBytes ?? options.maxSingleUploadBytes;
  const maxMetadataBytes = options.maxMetadataBytes;
  const defaultContentType = options.defaultContentType ?? DEFAULT_CONTENT_TYPE;

  if (multipartPartSizeBytes < minMultipartPartSizeBytes) {
    throw new Error(
      `Multipart part size must be at least ${minMultipartPartSizeBytes} bytes for R2 uploads`,
    );
  }
  if (multipartPartSizeBytes > maxMultipartPartSizeBytes) {
    throw new Error(
      `Multipart part size must be at most ${maxMultipartPartSizeBytes} bytes for R2 uploads`,
    );
  }

  const resolveStorageKey = (input: { provider: string; fileKey: string }) => {
    const provider = normalizeProvider(input.provider);
    const fileKey = assertFileKey(input.fileKey);
    const storageKey = [storageKeyPrefix, provider, fileKey].filter(Boolean).join("/");

    if (storageKey.length === 0) {
      throw new Error("Storage key cannot be empty");
    }

    if (new TextEncoder().encode(storageKey).byteLength > maxStorageKeyLengthBytes) {
      throw new Error("Storage key exceeds maximum length");
    }

    return storageKey;
  };

  const resolveMultipartPartSize = (sizeBytes?: bigint | null) => {
    let partSize = multipartPartSizeBytes;

    if (sizeBytes !== undefined && sizeBytes !== null && sizeBytes > 0n) {
      const minPartSizeForLimit = divideCeil(sizeBytes, BigInt(maxMultipartParts));
      if (minPartSizeForLimit > BigInt(maxMultipartPartSizeBytes)) {
        throw new Error("Multipart upload exceeds maximum number of parts");
      }
      if (minPartSizeForLimit > BigInt(partSize)) {
        partSize = Number(minPartSizeForLimit);
      }
    }

    if (partSize < minMultipartPartSizeBytes) {
      throw new Error("Multipart part size is smaller than minimum allowed size");
    }
    if (partSize > maxMultipartPartSizeBytes) {
      throw new Error("Multipart part size exceeds maximum allowed size");
    }

    return partSize;
  };

  // FIXME: This decision currently trusts caller-provided sizeBytes. To enforce
  // maxSingleUploadBytes/maxMultipartUploadBytes for unknown or underreported streams,
  // the proxy path needs real byte counting while reading the body.
  const shouldUseMultipartUpload = (sizeBytes?: bigint | null) => {
    if (sizeBytes === undefined || sizeBytes === null || sizeBytes <= 0n) {
      return false;
    }

    if (multipartThresholdBytes !== undefined && sizeBytes >= BigInt(multipartThresholdBytes)) {
      return true;
    }

    if (maxSingleUploadBytes !== undefined && sizeBytes > BigInt(maxSingleUploadBytes)) {
      return true;
    }

    return false;
  };

  const writeMultipartStream = async (input: {
    storageKey: string;
    body: ReadableStream<Uint8Array>;
    contentType?: string | null;
    sizeBytes?: bigint | null;
    partSizeBytes: number;
  }) => {
    const multipartUpload = await options.bucket.createMultipartUpload(input.storageKey, {
      httpMetadata: input.contentType ? { contentType: input.contentType } : undefined,
    });

    if (!multipartUpload.uploadId) {
      throw new Error("STORAGE_ERROR");
    }

    const uploadedParts: R2BindingUploadedPart[] = [];
    const reader = input.body.getReader();
    const bufferedChunks: Uint8Array[] = [];
    let bufferedBytes = 0;
    let partNumber = 1;
    let uploadedBytes = 0n;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!value || value.byteLength === 0) {
          continue;
        }

        uploadedBytes += BigInt(value.byteLength);
        // TODO: Enforce the effective max upload bytes from uploadedBytes while streaming,
        // instead of relying on input.sizeBytes to reject oversized proxy uploads.
        bufferedChunks.push(value);
        bufferedBytes += value.byteLength;

        while (bufferedBytes >= input.partSizeBytes) {
          if (partNumber > maxMultipartParts) {
            throw new Error("Multipart upload exceeds maximum number of parts");
          }

          const part = takeBytesFromChunks(bufferedChunks, input.partSizeBytes);
          bufferedBytes -= input.partSizeBytes;

          const uploadedPart = await multipartUpload.uploadPart(partNumber, part);
          uploadedParts.push(normalizeUploadedPart(uploadedPart, partNumber));
          partNumber += 1;
        }
      }

      assertSizeMatches({ expected: input.sizeBytes, actual: uploadedBytes });

      if (bufferedBytes > 0 || uploadedParts.length === 0) {
        if (partNumber > maxMultipartParts) {
          throw new Error("Multipart upload exceeds maximum number of parts");
        }

        const finalPart =
          bufferedBytes > 0
            ? takeBytesFromChunks(bufferedChunks, bufferedBytes)
            : new Uint8Array(0);
        bufferedBytes = 0;

        const uploadedPart = await multipartUpload.uploadPart(partNumber, finalPart);
        uploadedParts.push(normalizeUploadedPart(uploadedPart, partNumber));
      }

      const completed = await multipartUpload.complete(uploadedParts);
      return {
        ...(resolveEtag(completed) ? { etag: resolveEtag(completed) } : {}),
        sizeBytes: uploadedBytes,
      };
    } catch (error) {
      try {
        await multipartUpload.abort();
      } catch {
        // Ignore abort failures to preserve the original storage error.
      }
      throw error;
    } finally {
      reader.releaseLock();
    }
  };

  return {
    name: "r2-binding",
    capabilities: {
      directUpload: false,
      multipartUpload: true,
      signedDownload: false,
      proxyUpload: true,
    },
    limits: {
      maxSingleUploadBytes,
      maxMultipartUploadBytes,
      minMultipartPartSizeBytes,
      maxMultipartPartSizeBytes,
      maxMultipartParts,
      maxStorageKeyLengthBytes,
      maxMetadataBytes,
    },
    recommendations: {
      uploadExpiresInSeconds,
      signedUrlExpiresInSeconds: options.signedUrlExpiresInSeconds,
      directUploadThresholdBytes: options.directUploadThresholdBytes,
      multipartThresholdBytes,
      multipartPartSizeBytes,
    },
    resolveStorageKey,
    initUpload: async ({ provider, fileKey, sizeBytes, metadata }) => {
      const storageKey = resolveStorageKey({ provider, fileKey });

      if (maxUploadBytes !== undefined && sizeBytes > BigInt(maxUploadBytes)) {
        throw new Error("Upload exceeds maximum upload size");
      }

      if (maxMetadataBytes !== undefined && resolveMetadataSize(metadata) > maxMetadataBytes) {
        throw new Error("Metadata exceeds maximum size");
      }

      return {
        strategy: "proxy",
        storageKey,
        expiresAt: new Date(Date.now() + uploadExpiresInSeconds * 1000),
      };
    },
    writeStream: async ({ storageKey, body, contentType, sizeBytes }) => {
      if (
        maxUploadBytes !== undefined &&
        sizeBytes !== undefined &&
        sizeBytes !== null &&
        sizeBytes > BigInt(maxUploadBytes)
      ) {
        throw new Error("Upload exceeds maximum upload size");
      }

      if (shouldUseMultipartUpload(sizeBytes)) {
        const partSizeBytes = resolveMultipartPartSize(sizeBytes);
        return writeMultipartStream({
          storageKey,
          body,
          contentType,
          sizeBytes,
          partSizeBytes,
        });
      }

      // TODO: Wrap the single-put body in a counting/limiting stream so unknown or
      // underreported sizeBytes cannot bypass configured max upload limits.
      const result = await options.bucket.put(storageKey, body, {
        httpMetadata: contentType ? { contentType } : undefined,
      });

      const size = typeof result.size === "number" ? BigInt(result.size) : (sizeBytes ?? undefined);
      assertSizeMatches({ expected: sizeBytes, actual: size });
      const etag = resolveEtag(result);

      return {
        ...(etag ? { etag } : {}),
        ...(size !== undefined ? { sizeBytes: size } : {}),
      };
    },
    deleteObject: async ({ storageKey }) => {
      await options.bucket.delete(storageKey);
    },
    getDownloadStream: async ({ storageKey }) => {
      const object = await options.bucket.get(storageKey);
      if (!object || !object.body) {
        throw new Error("STORAGE_ERROR");
      }

      const headers = new Headers();
      headers.set("Content-Type", object.httpMetadata?.contentType || defaultContentType);
      headers.set("ETag", object.httpEtag);
      headers.set("Content-Length", object.size.toString());

      return new Response(object.body, { headers });
    },
  };
}

const isR2BindingBucket = (candidate: unknown): candidate is R2BindingBucket => {
  if (!candidate || typeof candidate !== "object") {
    return false;
  }

  const bucket = candidate as Partial<R2BindingBucket>;
  return (
    typeof bucket.put === "function" &&
    typeof bucket.get === "function" &&
    typeof bucket.delete === "function" &&
    typeof bucket.createMultipartUpload === "function"
  );
};

export const resolveR2BindingBucket = (
  bindings: Record<string, unknown>,
  bindingName: string,
): R2BindingBucket => {
  const candidate = bindings[bindingName];
  if (!isR2BindingBucket(candidate)) {
    throw new Error(`Upload R2 bucket binding '${bindingName}' is not configured.`);
  }
  return candidate;
};
