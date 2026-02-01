import { encodeFileKey, type FileKeyEncoded, type FileKeyParts } from "../keys";
import type { StorageAdapter, UploadChecksum } from "./types";

const BYTES_IN_MIB = 1024 * 1024;
const BYTES_IN_GIB = 1024 * BYTES_IN_MIB;
const BYTES_IN_TIB = 1024 * BYTES_IN_GIB;

const DEFAULT_MAX_SINGLE_UPLOAD_BYTES = 5 * BYTES_IN_GIB;
const DEFAULT_MAX_MULTIPART_UPLOAD_BYTES = 5 * BYTES_IN_TIB;
const DEFAULT_MIN_MULTIPART_PART_SIZE_BYTES = 5 * BYTES_IN_MIB;
const DEFAULT_MAX_MULTIPART_PART_SIZE_BYTES = 5 * BYTES_IN_GIB;
const DEFAULT_MAX_MULTIPART_PARTS = 10_000;
const DEFAULT_MAX_STORAGE_KEY_LENGTH_BYTES = 1024;
const DEFAULT_UPLOAD_EXPIRES_IN_SECONDS = 60 * 60;
const DEFAULT_SIGNED_URL_EXPIRES_IN_SECONDS = 60 * 60;
const DEFAULT_MULTIPART_PART_SIZE_BYTES = 8 * BYTES_IN_MIB;
const MAX_PRESIGNED_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7;

export type S3SignerInput = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | null;
  expiresInSeconds?: number;
};

export type S3Signer = {
  sign: (input: S3SignerInput) => Promise<{ url: string; headers: Record<string, string> }>;
  presign: (input: S3SignerInput) => Promise<{ url: string; headers?: Record<string, string> }>;
};

export type S3CompatibleStorageAdapterOptions = {
  bucket: string;
  endpoint: string;
  signer: S3Signer;
  storageKeyPrefix?: string;
  pathStyle?: boolean;
  uploadExpiresInSeconds?: number;
  signedUrlExpiresInSeconds?: number;
  directUploadThresholdBytes?: number;
  multipartThresholdBytes?: number;
  multipartPartSizeBytes?: number;
  maxSingleUploadBytes?: number;
  maxMultipartUploadBytes?: number;
  minMultipartPartSizeBytes?: number;
  maxMultipartPartSizeBytes?: number;
  maxMultipartParts?: number;
  maxStorageKeyLengthBytes?: number;
  maxMetadataBytes?: number;
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

const resolveStorageKeyFromParts = (input: {
  fileKey: FileKeyEncoded;
  fileKeyParts: FileKeyParts;
}): string => {
  const encoded = input.fileKeyParts.length > 0 ? encodeFileKey(input.fileKeyParts) : input.fileKey;
  return encoded.length > 0 ? encoded.split(".").join("/") : "";
};

const encodePathSegments = (value: string) =>
  value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

const joinPathSegments = (...segments: (string | undefined)[]) => {
  const trimmed = segments.filter(Boolean).map((segment) => segment!.replace(/^\/+|\/+$/g, ""));
  return trimmed.join("/");
};

const parseHex = (value: string, expectedBytes: number) => {
  const trimmed = value.trim();
  if (!/^[0-9a-f]+$/i.test(trimmed) || trimmed.length !== expectedBytes * 2) {
    return null;
  }
  return Buffer.from(trimmed, "hex");
};

const parseBase64 = (value: string, expectedBytes: number) => {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(trimmed)) {
    return null;
  }
  const buf = Buffer.from(trimmed, "base64");
  if (buf.length !== expectedBytes) {
    return null;
  }
  return buf;
};

const normalizeChecksum = (checksum?: UploadChecksum | null) => {
  if (!checksum) {
    return null;
  }

  const expectedBytes = checksum.algo === "md5" ? 16 : 32;
  const raw = checksum.value ?? "";
  const buf = parseHex(raw, expectedBytes) ?? parseBase64(raw, expectedBytes);
  if (!buf) {
    return null;
  }

  return {
    algo: checksum.algo,
    hex: buf.toString("hex"),
    base64: buf.toString("base64"),
  };
};

const resolveChecksumHeaders = (checksum?: UploadChecksum | null) => {
  const normalized = normalizeChecksum(checksum);
  if (!normalized) {
    return {};
  }

  if (normalized.algo === "md5") {
    return { "Content-MD5": normalized.base64 };
  }

  return { "x-amz-checksum-sha256": normalized.base64 };
};

const normalizeEtag = (etag: string | null) => {
  if (!etag) {
    return null;
  }

  const trimmed = etag.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  if (!/^[0-9a-f]{32}$/i.test(trimmed)) {
    return null;
  }

  return trimmed.toLowerCase();
};

const parseContentLength = (value: string | null) => {
  if (!value) {
    return null;
  }
  if (!/^\d+$/.test(value)) {
    return null;
  }
  return BigInt(value);
};

const getHeaderValue = (headers: Headers, name: string) => {
  const direct = headers.get(name);
  if (direct !== null) {
    return direct;
  }
  const target = name.toLowerCase();
  for (const [key, value] of headers.entries()) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return null;
};

const buildObjectUrl = (input: {
  endpoint: string;
  bucket: string;
  storageKey: string;
  pathStyle: boolean;
}) => {
  const url = new URL(input.endpoint);
  const encodedKey = encodePathSegments(input.storageKey);
  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/g, "");

  if (input.pathStyle) {
    const path = joinPathSegments(basePath, input.bucket, encodedKey);
    url.pathname = path ? `/${path}` : "/";
    return url;
  }

  url.hostname = `${input.bucket}.${url.hostname}`;
  const path = joinPathSegments(basePath, encodedKey);
  url.pathname = path ? `/${path}` : "/";
  return url;
};

const assertExpiresInSeconds = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Expiration must be a positive number of seconds");
  }
  if (value > MAX_PRESIGNED_EXPIRES_IN_SECONDS) {
    throw new Error("Expiration exceeds SigV4 maximum of 7 days");
  }
};

const resolveMetadataSize = (metadata?: Record<string, unknown> | null) => {
  if (!metadata) {
    return 0;
  }

  const serialized = JSON.stringify(metadata);
  return Buffer.byteLength(serialized, "utf8");
};

const parseUploadId = (payload: string) => {
  const match = payload.match(/<UploadId>([^<]+)<\/UploadId>/);
  if (!match) {
    return null;
  }

  return match[1];
};

const escapeXml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const buildCompleteMultipartBody = (parts: { partNumber: number; etag: string }[]) => {
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  const entries = sorted
    .map(
      (part) =>
        `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(
          part.etag,
        )}</ETag></Part>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>${entries}</CompleteMultipartUpload>`;
};

const resolveMultipartPartSize = (input: {
  sizeBytes: bigint;
  desiredPartSizeBytes: number;
  minPartSizeBytes: number;
  maxPartSizeBytes: number;
  maxParts: number;
}) => {
  let partSize = input.desiredPartSizeBytes;

  if (partSize < input.minPartSizeBytes) {
    partSize = input.minPartSizeBytes;
  }

  if (partSize > input.maxPartSizeBytes) {
    throw new Error("Multipart part size exceeds maximum allowed size");
  }

  const sizeNumber = Number(input.sizeBytes);
  const minimumPartSizeForLimit = Math.ceil(sizeNumber / input.maxParts);

  if (minimumPartSizeForLimit > partSize) {
    partSize = minimumPartSizeForLimit;
  }

  if (partSize < input.minPartSizeBytes) {
    partSize = input.minPartSizeBytes;
  }

  if (partSize > input.maxPartSizeBytes) {
    throw new Error("Multipart part size exceeds maximum allowed size");
  }

  const partCount = Math.ceil(sizeNumber / partSize);
  if (partCount > input.maxParts) {
    throw new Error("Multipart upload exceeds maximum number of parts");
  }

  return partSize;
};

export function createS3CompatibleStorageAdapter(
  options: S3CompatibleStorageAdapterOptions,
): StorageAdapter {
  const storageKeyPrefix = normalizePrefix(options.storageKeyPrefix ?? "");
  const pathStyle = options.pathStyle ?? false;
  const maxStorageKeyLengthBytes =
    options.maxStorageKeyLengthBytes ?? DEFAULT_MAX_STORAGE_KEY_LENGTH_BYTES;
  const maxSingleUploadBytes = options.maxSingleUploadBytes ?? DEFAULT_MAX_SINGLE_UPLOAD_BYTES;
  const maxMultipartUploadBytes =
    options.maxMultipartUploadBytes ?? DEFAULT_MAX_MULTIPART_UPLOAD_BYTES;
  const minMultipartPartSizeBytes =
    options.minMultipartPartSizeBytes ?? DEFAULT_MIN_MULTIPART_PART_SIZE_BYTES;
  const maxMultipartPartSizeBytes =
    options.maxMultipartPartSizeBytes ?? DEFAULT_MAX_MULTIPART_PART_SIZE_BYTES;
  const maxMultipartParts = options.maxMultipartParts ?? DEFAULT_MAX_MULTIPART_PARTS;
  const uploadExpiresInSeconds =
    options.uploadExpiresInSeconds ?? DEFAULT_UPLOAD_EXPIRES_IN_SECONDS;
  const signedUrlExpiresInSeconds =
    options.signedUrlExpiresInSeconds ?? DEFAULT_SIGNED_URL_EXPIRES_IN_SECONDS;
  const directUploadThresholdBytes = options.directUploadThresholdBytes ?? maxSingleUploadBytes;
  const multipartThresholdBytes = options.multipartThresholdBytes ?? maxSingleUploadBytes;
  const multipartPartSizeBytes =
    options.multipartPartSizeBytes ?? DEFAULT_MULTIPART_PART_SIZE_BYTES;

  assertExpiresInSeconds(uploadExpiresInSeconds);
  assertExpiresInSeconds(signedUrlExpiresInSeconds);

  const resolveStorageKey = (input: { fileKey: FileKeyEncoded; fileKeyParts: FileKeyParts }) => {
    const baseKey = resolveStorageKeyFromParts(input);
    const storageKey = [storageKeyPrefix, baseKey].filter(Boolean).join("/");

    if (storageKey.length === 0) {
      throw new Error("Storage key cannot be empty");
    }

    if (Buffer.byteLength(storageKey, "utf8") > maxStorageKeyLengthBytes) {
      throw new Error("Storage key exceeds maximum length");
    }

    return storageKey;
  };

  const buildUrl = (storageKey: string, queryParams: Record<string, string | undefined> = {}) => {
    const url = buildObjectUrl({
      endpoint: options.endpoint,
      bucket: options.bucket,
      storageKey,
      pathStyle,
    });

    for (const [key, value] of Object.entries(queryParams)) {
      if (value === undefined) {
        continue;
      }
      url.searchParams.set(key, value);
    }

    return url;
  };

  const validateMetadata = (metadata?: Record<string, unknown> | null) => {
    if (!metadata) {
      return;
    }

    if (options.maxMetadataBytes === undefined) {
      return;
    }

    if (resolveMetadataSize(metadata) > options.maxMetadataBytes) {
      throw new Error("Metadata exceeds maximum size");
    }
  };

  return {
    name: "s3",
    capabilities: {
      directUpload: true,
      multipartUpload: true,
      signedDownload: true,
      proxyUpload: false,
    },
    limits: {
      maxSingleUploadBytes,
      maxMultipartUploadBytes,
      minMultipartPartSizeBytes,
      maxMultipartPartSizeBytes,
      maxMultipartParts,
      maxStorageKeyLengthBytes,
      maxMetadataBytes: options.maxMetadataBytes,
    },
    recommendations: {
      uploadExpiresInSeconds,
      signedUrlExpiresInSeconds,
      directUploadThresholdBytes,
      multipartThresholdBytes,
      multipartPartSizeBytes,
    },
    resolveStorageKey,
    initUpload: async ({ fileKey, fileKeyParts, sizeBytes, contentType, metadata, checksum }) => {
      validateMetadata(metadata);
      const storageKey = resolveStorageKey({ fileKey, fileKeyParts });

      const expiresAt = new Date(Date.now() + uploadExpiresInSeconds * 1000);
      const sizeNumber = Number(sizeBytes);

      if (Number.isNaN(sizeNumber) || sizeNumber < 0) {
        throw new Error("Upload size must be a non-negative number");
      }

      const canMultipart = sizeNumber <= maxMultipartUploadBytes;
      const canSingle = sizeNumber <= maxSingleUploadBytes;

      if (!canMultipart) {
        throw new Error("Upload exceeds maximum multipart size");
      }

      const prefersMultipart = sizeNumber >= multipartThresholdBytes;
      const canUseSingle = canSingle && sizeNumber <= directUploadThresholdBytes;

      if (prefersMultipart || !canUseSingle) {
        if (!canMultipart) {
          throw new Error("Upload exceeds maximum multipart size");
        }

        const partSizeBytes = resolveMultipartPartSize({
          sizeBytes,
          desiredPartSizeBytes: multipartPartSizeBytes,
          minPartSizeBytes: minMultipartPartSizeBytes,
          maxPartSizeBytes: maxMultipartPartSizeBytes,
          maxParts: maxMultipartParts,
        });

        const createUrl = buildUrl(storageKey, { uploads: "" });
        const signed = await options.signer.sign({
          method: "POST",
          url: createUrl.toString(),
          headers: {
            "Content-Type": contentType,
          },
        });

        const response = await fetch(signed.url, {
          method: "POST",
          headers: signed.headers,
        });

        if (!response.ok) {
          throw new Error(`Failed to create multipart upload (${response.status})`);
        }

        const payload = await response.text();
        const uploadId = parseUploadId(payload);
        if (!uploadId) {
          throw new Error("Failed to parse multipart upload id");
        }

        return {
          strategy: "direct-multipart",
          storageKey,
          storageUploadId: uploadId,
          partSizeBytes,
          expiresAt,
        };
      }

      if (!canSingle) {
        throw new Error("Upload exceeds maximum single upload size");
      }

      const uploadUrl = buildUrl(storageKey);
      const checksumHeaders = resolveChecksumHeaders(checksum);
      const signed = await options.signer.presign({
        method: "PUT",
        url: uploadUrl.toString(),
        headers: {
          "Content-Type": contentType,
          ...checksumHeaders,
        },
        expiresInSeconds: uploadExpiresInSeconds,
      });

      return {
        strategy: "direct-single",
        storageKey,
        expiresAt,
        uploadUrl: signed.url,
        uploadHeaders: signed.headers,
      };
    },
    getPartUploadUrls: async ({ storageKey, storageUploadId, partNumbers }) => {
      for (const partNumber of partNumbers) {
        if (partNumber < 1 || partNumber > maxMultipartParts) {
          throw new Error("Part number is out of range");
        }
      }

      const urls = await Promise.all(
        partNumbers.map(async (partNumber) => {
          const url = buildUrl(storageKey, {
            partNumber: String(partNumber),
            uploadId: storageUploadId,
          });
          const signed = await options.signer.presign({
            method: "PUT",
            url: url.toString(),
            expiresInSeconds: uploadExpiresInSeconds,
          });

          return {
            partNumber,
            url: signed.url,
            headers: signed.headers,
          };
        }),
      );

      return urls;
    },
    completeMultipartUpload: async ({ storageKey, storageUploadId, parts }) => {
      const url = buildUrl(storageKey, { uploadId: storageUploadId });
      const body = buildCompleteMultipartBody(parts);
      const signed = await options.signer.sign({
        method: "POST",
        url: url.toString(),
        headers: {
          "Content-Type": "application/xml",
        },
        body,
      });

      const response = await fetch(signed.url, {
        method: "POST",
        headers: signed.headers,
        body,
      });

      if (!response.ok) {
        throw new Error(`Failed to complete multipart upload (${response.status})`);
      }

      const etag = response.headers.get("ETag") ?? undefined;
      return { etag };
    },
    abortMultipartUpload: async ({ storageKey, storageUploadId }) => {
      const url = buildUrl(storageKey, { uploadId: storageUploadId });
      const signed = await options.signer.sign({
        method: "DELETE",
        url: url.toString(),
      });

      const response = await fetch(signed.url, {
        method: "DELETE",
        headers: signed.headers,
      });

      if (!response.ok) {
        throw new Error(`Failed to abort multipart upload (${response.status})`);
      }
    },
    finalizeUpload: async ({ storageKey, expectedSizeBytes, checksum }) => {
      const url = buildUrl(storageKey);
      const signed = await options.signer.sign({
        method: "HEAD",
        url: url.toString(),
      });

      const response = await fetch(signed.url, {
        method: "HEAD",
        headers: signed.headers,
      });

      if (!response.ok) {
        throw new Error("STORAGE_ERROR");
      }

      const sizeHeader = getHeaderValue(response.headers, "content-length");
      const sizeBytes = parseContentLength(sizeHeader);
      if (sizeBytes === null) {
        throw new Error("STORAGE_ERROR");
      }
      if (sizeBytes !== expectedSizeBytes) {
        throw new Error("INVALID_CHECKSUM");
      }

      const normalized = normalizeChecksum(checksum);
      if (normalized) {
        if (normalized.algo === "md5") {
          const etag = normalizeEtag(getHeaderValue(response.headers, "etag"));
          if (etag && etag !== normalized.hex) {
            throw new Error("INVALID_CHECKSUM");
          }
        } else {
          const checksumHeader = getHeaderValue(response.headers, "x-amz-checksum-sha256");
          if (checksumHeader) {
            const remote = parseBase64(checksumHeader, 32);
            if (remote && remote.toString("base64") !== normalized.base64) {
              throw new Error("INVALID_CHECKSUM");
            }
          }
        }
      }

      const etag = getHeaderValue(response.headers, "etag");
      return { sizeBytes, etag: etag ?? undefined };
    },
    deleteObject: async ({ storageKey }) => {
      const url = buildUrl(storageKey);
      const signed = await options.signer.sign({
        method: "DELETE",
        url: url.toString(),
      });

      const response = await fetch(signed.url, {
        method: "DELETE",
        headers: signed.headers,
      });

      if (!response.ok) {
        throw new Error(`Failed to delete object (${response.status})`);
      }
    },
    getDownloadUrl: async ({ storageKey, expiresInSeconds, contentDisposition, contentType }) => {
      assertExpiresInSeconds(expiresInSeconds);

      const url = buildUrl(storageKey, {
        "response-content-disposition": contentDisposition,
        "response-content-type": contentType,
      });

      const signed = await options.signer.presign({
        method: "GET",
        url: url.toString(),
        expiresInSeconds,
      });

      return {
        url: signed.url,
        headers: signed.headers,
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
      };
    },
  };
}
