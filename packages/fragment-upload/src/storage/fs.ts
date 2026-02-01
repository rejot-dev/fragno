import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { encodeFileKey, type FileKeyEncoded, type FileKeyParts } from "../keys";
import type { StorageAdapter } from "./types";

const DEFAULT_MAX_STORAGE_KEY_LENGTH_BYTES = 1024;
const DEFAULT_UPLOAD_EXPIRES_IN_SECONDS = 60 * 60;
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export type FilesystemStorageAdapterOptions = {
  rootDir: string;
  storageKeyPrefix?: string;
  uploadExpiresInSeconds?: number;
  maxStorageKeyLengthBytes?: number;
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

const resolveStorageKeyFromParts = (input: {
  fileKey: FileKeyEncoded;
  fileKeyParts: FileKeyParts;
}): string => {
  const encoded = input.fileKeyParts.length > 0 ? encodeFileKey(input.fileKeyParts) : input.fileKey;
  return encoded.length > 0 ? encoded.split(".").join("/") : "";
};

export function createFilesystemStorageAdapter(
  options: FilesystemStorageAdapterOptions,
): StorageAdapter {
  const rootDir = path.resolve(options.rootDir);
  const storageKeyPrefix = normalizePrefix(options.storageKeyPrefix ?? "");
  const maxStorageKeyLengthBytes =
    options.maxStorageKeyLengthBytes ?? DEFAULT_MAX_STORAGE_KEY_LENGTH_BYTES;
  const uploadExpiresInSeconds =
    options.uploadExpiresInSeconds ?? DEFAULT_UPLOAD_EXPIRES_IN_SECONDS;
  const defaultContentType = options.defaultContentType ?? DEFAULT_CONTENT_TYPE;

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

  const resolveFilePath = (storageKey: string) => {
    if (storageKey.includes("\\")) {
      throw new Error("Storage key must use forward slashes");
    }

    const segments = storageKey.split("/").filter(Boolean);
    if (segments.length === 0) {
      throw new Error("Storage key cannot be empty");
    }

    const filePath = path.resolve(rootDir, ...segments);
    const rootWithSep = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;
    if (filePath !== rootDir && !filePath.startsWith(rootWithSep)) {
      throw new Error("Storage key resolves outside the root directory");
    }

    return filePath;
  };

  return {
    name: "filesystem",
    capabilities: {
      directUpload: false,
      multipartUpload: false,
      signedDownload: false,
      proxyUpload: true,
    },
    limits: {
      maxStorageKeyLengthBytes,
    },
    recommendations: {
      uploadExpiresInSeconds,
    },
    resolveStorageKey,
    initUpload: async ({ fileKey, fileKeyParts }) => {
      const storageKey = resolveStorageKey({ fileKey, fileKeyParts });
      await fs.mkdir(rootDir, { recursive: true });

      return {
        strategy: "proxy",
        storageKey,
        expiresAt: new Date(Date.now() + uploadExpiresInSeconds * 1000),
      };
    },
    writeStream: async ({ storageKey, body }) => {
      const filePath = resolveFilePath(storageKey);
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      const readable = Readable.fromWeb(body as unknown as NodeReadableStream);
      await pipeline(readable, createWriteStream(filePath));
      const stats = await fs.stat(filePath);

      return { sizeBytes: BigInt(stats.size) };
    },
    deleteObject: async ({ storageKey }) => {
      const filePath = resolveFilePath(storageKey);
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    },
    getDownloadStream: async ({ storageKey }) => {
      const filePath = resolveFilePath(storageKey);
      const stats = await fs.stat(filePath);
      const stream = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream;

      return new Response(stream, {
        headers: {
          "Content-Type": defaultContentType,
          "Content-Length": stats.size.toString(),
        },
      });
    },
  };
}
