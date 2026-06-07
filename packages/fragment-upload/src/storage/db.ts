import { createHandlerTxBuilder, type DatabaseAdapter } from "@fragno-dev/db";

import { assertFileKey } from "../file-key";
import { uploadSchema } from "../schema";
import { appendStorageObjectKeyVersionSegment } from "./object-key";
import type { StorageAdapter } from "./types";

const DEFAULT_PROVIDER_NAME = "database";
const DEFAULT_MAX_STORAGE_KEY_LENGTH_BYTES = 1024;
const DEFAULT_UPLOAD_EXPIRES_IN_SECONDS = 60 * 60;
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export type DatabaseStorageAdapterOptions = {
  databaseAdapter: DatabaseAdapter<unknown>;
  databaseNamespace?: string | null;
  providerName?: string;
  storageKeyPrefix?: string;
  uploadExpiresInSeconds?: number;
  maxObjectBytes?: number;
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

const normalizeByteLimit = (value: number | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("maxObjectBytes must be a positive safe integer");
  }

  return value;
};

const normalizeBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  throw new Error("STORAGE_ERROR");
};

const readStream = async (
  body: ReadableStream<Uint8Array>,
  maxObjectBytes: number | undefined,
): Promise<Uint8Array> => {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      totalBytes += value.byteLength;
      if (maxObjectBytes !== undefined && totalBytes > maxObjectBytes) {
        throw new Error("STORAGE_ERROR");
      }

      chunks.push(value.slice());
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
};

export function createDatabaseStorageAdapter(
  options: DatabaseStorageAdapterOptions,
): StorageAdapter {
  const databaseAdapter = options.databaseAdapter;
  const databaseNamespace = options.databaseNamespace ?? uploadSchema.name;
  const providerName = options.providerName ?? DEFAULT_PROVIDER_NAME;
  const storageKeyPrefix = normalizePrefix(options.storageKeyPrefix ?? "");
  const uploadExpiresInSeconds =
    options.uploadExpiresInSeconds ?? DEFAULT_UPLOAD_EXPIRES_IN_SECONDS;
  const maxObjectBytes = normalizeByteLimit(options.maxObjectBytes);
  const maxStorageKeyLengthBytes =
    options.maxStorageKeyLengthBytes ?? DEFAULT_MAX_STORAGE_KEY_LENGTH_BYTES;
  const defaultContentType = options.defaultContentType ?? DEFAULT_CONTENT_TYPE;

  databaseAdapter.registerSchema(uploadSchema, databaseNamespace);

  const createStorageTx = (name: string) =>
    createHandlerTxBuilder({
      createUnitOfWork: () => {
        const uow = databaseAdapter.createBaseUnitOfWork(name);
        uow.registerSchema(uploadSchema, databaseNamespace);
        return uow;
      },
    });

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

  const readObject = async (storageKey: string) => {
    return await createStorageTx("upload-storage-read")
      .retrieve(({ forSchema }) =>
        forSchema(uploadSchema).findFirst("storage_object", (b) =>
          b.whereIndex("idx_storage_object_key", (eb) => eb("storageKey", "=", storageKey)),
        ),
      )
      .transformRetrieve(([object]) => object ?? null)
      .execute();
  };

  return {
    name: providerName,
    capabilities: {
      directUpload: false,
      multipartUpload: false,
      signedDownload: false,
      proxyUpload: true,
    },
    limits: {
      maxSingleUploadBytes: maxObjectBytes,
      maxStorageKeyLengthBytes,
    },
    recommendations: {
      uploadExpiresInSeconds,
    },
    resolveStorageKey,
    initUpload: async ({ provider, fileKey, sizeBytes, objectKeyVersionSegment }) => {
      if (maxObjectBytes !== undefined && sizeBytes > BigInt(maxObjectBytes)) {
        throw new Error("STORAGE_ERROR");
      }

      const storageKey = appendStorageObjectKeyVersionSegment(
        resolveStorageKey({ provider, fileKey }),
        objectKeyVersionSegment,
        maxStorageKeyLengthBytes,
      );

      return {
        strategy: "proxy",
        storageKey,
        expiresAt: new Date(Date.now() + uploadExpiresInSeconds * 1000),
      };
    },
    writeStream: async ({ storageKey, body, contentType, sizeBytes }) => {
      if (
        maxObjectBytes !== undefined &&
        sizeBytes !== undefined &&
        sizeBytes !== null &&
        sizeBytes > BigInt(maxObjectBytes)
      ) {
        throw new Error("STORAGE_ERROR");
      }

      const bytes = await readStream(body, maxObjectBytes);
      const now = new Date();
      const storedContentType = contentType || defaultContentType;
      const storedSizeBytes = BigInt(bytes.byteLength);

      await createStorageTx("upload-storage-write")
        .retrieve(({ forSchema }) =>
          forSchema(uploadSchema).findFirst("storage_object", (b) =>
            b.whereIndex("idx_storage_object_key", (eb) => eb("storageKey", "=", storageKey)),
          ),
        )
        .mutate(({ forSchema, retrieveResult: [existingObject] }) => {
          const uow = forSchema(uploadSchema);

          if (existingObject) {
            uow.update("storage_object", existingObject.id, (b) =>
              b
                .set({
                  body: bytes,
                  contentType: storedContentType,
                  sizeBytes: storedSizeBytes,
                  updatedAt: now,
                })
                .check(),
            );
            return;
          }

          uow.create("storage_object", {
            storageKey,
            body: bytes,
            contentType: storedContentType,
            sizeBytes: storedSizeBytes,
            createdAt: now,
            updatedAt: now,
          });
        })
        .execute();

      return { sizeBytes: storedSizeBytes };
    },
    deleteObject: async ({ storageKey }) => {
      await createStorageTx("upload-storage-delete")
        .retrieve(({ forSchema }) =>
          forSchema(uploadSchema).findFirst("storage_object", (b) =>
            b.whereIndex("idx_storage_object_key", (eb) => eb("storageKey", "=", storageKey)),
          ),
        )
        .mutate(({ forSchema, retrieveResult: [existingObject] }) => {
          if (!existingObject) {
            return;
          }

          forSchema(uploadSchema).delete("storage_object", existingObject.id, (b) => b.check());
        })
        .execute();
    },
    getDownloadStream: async ({ storageKey }) => {
      const object = await readObject(storageKey);
      if (!object) {
        throw new Error("STORAGE_ERROR");
      }

      const body = normalizeBytes(object.body);

      return new Response(body.slice(), {
        headers: {
          "Content-Type": object.contentType || defaultContentType,
          "Content-Length": object.sizeBytes.toString(),
        },
      });
    },
  };
}
