import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import { blobsFragmentDefinition, type StoredBlob, type UnfinishedUpload } from "./definition";
import { blobsSchema } from "./schema";
import type { StoredObject } from "./storage";

const UPLOAD_EXPIRES_IN_SECONDS = 60 * 60;
const DOWNLOAD_URL_EXPIRES_IN_SECONDS = 60 * 60;
// Storage checks a presigned URL's expiry when a request starts, so a PUT that began just before its
// URL expired may still be landing afterwards.
const UNFINISHED_UPLOAD_DISCARD_GRACE_MS = 60 * 60 * 1000;
// S3's limit on object key length.
const MAX_OBJECT_KEY_BYTES = 1024;
/** The most bytes one range read returns; it bounds what the read holds in memory. */
export const BLOBS_MAX_RANGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;

const errorCodes = [
  "INVALID_KEY",
  "INVALID_RANGE",
  "RANGE_NOT_SATISFIABLE",
  "UPLOAD_NOT_FOUND",
  "UPLOAD_EXPIRED",
  "UPLOAD_CONTENT_MISSING",
  "BLOB_NOT_FOUND",
  "BLOB_CHANGED",
  "STORAGE_ERROR",
] as const;

type BlobsErrorCode = (typeof errorCodes)[number];

const ERROR_STATUS = {
  INVALID_KEY: 400,
  INVALID_RANGE: 400,
  RANGE_NOT_SATISFIABLE: 416,
  UPLOAD_NOT_FOUND: 404,
  UPLOAD_EXPIRED: 410,
  UPLOAD_CONTENT_MISSING: 409,
  BLOB_NOT_FOUND: 404,
  BLOB_CHANGED: 409,
  STORAGE_ERROR: 502,
} as const satisfies Record<BlobsErrorCode, number>;

class BlobsError extends Error {
  constructor(
    readonly code: BlobsErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const blobSchema = z.object({
  key: z.string(),
  sizeBytes: z.number(),
  contentType: z.string(),
  etag: z.string(),
});

function toBlob(blob: {
  key: string;
  sizeBytes: bigint;
  contentType: string;
  etag: string;
}): StoredBlob {
  return {
    key: blob.key,
    sizeBytes: Number(blob.sizeBytes),
    contentType: blob.contentType,
    etag: blob.etag,
  };
}

/** Slash-separated segments, none empty, `.`, or `..`, without control characters. */
function isBlobKey(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return false;
    }
  }
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function blobKeyQuery(query: URLSearchParams): string | null {
  const key = query.get("key");
  return key !== null && isBlobKey(key) ? key : null;
}

function integerQuery(query: URLSearchParams, name: string): number | null {
  const value = query.get(name);
  return value !== null && /^\d+$/.test(value) ? Number(value) : null;
}

export const blobsRoutesFactory = defineRoutes(blobsFragmentDefinition).create(
  ({ defineRoute, config }) => {
    const storagePrefix = config.storageKeyPrefix.replace(/^\/+|\/+$/g, "");

    return [
      defineRoute({
        method: "POST",
        path: "/uploads",
        inputSchema: z.object({ key: z.string(), contentType: z.string().min(1) }),
        outputSchema: z.object({
          uploadId: z.string(),
          key: z.string(),
          url: z.string(),
          headers: z.record(z.string(), z.string()),
          expiresAt: z.date(),
        }),
        errorCodes,
        handler: async function ({ input }, { json, error }) {
          const { key, contentType } = await input.valid();
          // Every upload gets its own object, so an unfinished upload never touches the blob. The
          // object's key ends in the blob's name, so browsers save downloads under that name.
          const segments = key.split("/");
          const objectKey = [
            storagePrefix,
            ...segments.slice(0, -1),
            crypto.randomUUID(),
            segments.at(-1),
          ]
            .filter(Boolean)
            .join("/");
          if (
            !isBlobKey(key) ||
            new TextEncoder().encode(objectKey).length > MAX_OBJECT_KEY_BYTES
          ) {
            return error({ message: "The blob key is invalid.", code: "INVALID_KEY" }, 400);
          }

          const expiresAt = new Date(Date.now() + UPLOAD_EXPIRES_IN_SECONDS * 1000);
          let presigned;
          try {
            presigned = await config.storage.createUploadUrl({
              objectKey,
              contentType,
              expiresInSeconds: UPLOAD_EXPIRES_IN_SECONDS,
            });
          } catch {
            return error({ message: "Storage error", code: "STORAGE_ERROR" }, 502);
          }

          const uploadId = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(blobsSchema).find("blob_upload", (b) =>
                b.whereIndex("idx_blob_upload_key", (eb) => eb("key", "=", key)),
              ),
            )
            .mutate(({ forSchema, retrieveResult: [replaced] }) => {
              const uow = forSchema(blobsSchema);
              // Replaced uploads can no longer complete; their own discards clean up what their
              // URLs store.
              for (const upload of replaced) {
                uow.delete("blob_upload", upload.id, (b) => b.check());
              }
              const id = uow.create("blob_upload", { key, objectKey, contentType, expiresAt });
              uow.triggerHook(
                "discardUnfinishedUpload",
                { uploadId: id.toString(), key, objectKey } satisfies UnfinishedUpload,
                { processAt: new Date(expiresAt.getTime() + UNFINISHED_UPLOAD_DISCARD_GRACE_MS) },
              );
              return id.toString();
            })
            .execute();

          return json({ uploadId, key, url: presigned.url, headers: presigned.headers, expiresAt });
        },
      }),

      defineRoute({
        method: "POST",
        path: "/uploads/:uploadId/complete",
        outputSchema: blobSchema,
        errorCodes,
        handler: async function ({ pathParams }, { json, error }) {
          let stored: StoredObject | null = null;
          try {
            const blob = await this.handlerTx()
              .retrieve(({ forSchema }) =>
                forSchema(blobsSchema).findFirst("blob_upload", (b) =>
                  b
                    .whereIndex("primary", (eb) => eb("id", "=", pathParams.uploadId))
                    .joinOne("blob", "blob", (blob) =>
                      blob.onIndex("idx_blob_key", (eb) => eb("key", "=", eb.parent("key"))),
                    ),
                ),
              )
              .afterRetrieve(async (_uow, [upload]) => {
                if (!upload) {
                  throw new BlobsError("UPLOAD_NOT_FOUND", "The upload does not exist.");
                }
                // A PUT that started before the URL expired may finish after it, so completion
                // stays open until the upload is discarded.
                if (upload.expiresAt.getTime() + UNFINISHED_UPLOAD_DISCARD_GRACE_MS <= Date.now()) {
                  throw new BlobsError("UPLOAD_EXPIRED", "The upload has expired.");
                }
                try {
                  stored = await config.storage.describeObject(upload.objectKey);
                } catch {
                  throw new BlobsError("STORAGE_ERROR", "Storage error");
                }
                if (stored === null) {
                  throw new BlobsError(
                    "UPLOAD_CONTENT_MISSING",
                    "Storage holds no bytes for the upload yet.",
                  );
                }
              })
              .mutate(({ forSchema, retrieveResult: [upload] }) => {
                // afterRetrieve rejected a missing upload and a missing object.
                const { blob: previous, ...completed } = upload!;
                const uow = forSchema(blobsSchema);
                const values = {
                  key: completed.key,
                  objectKey: completed.objectKey,
                  sizeBytes: stored!.sizeBytes,
                  contentType: completed.contentType,
                  etag: stored!.etag,
                };
                uow.delete("blob_upload", completed.id, (b) => b.check());
                if (previous) {
                  uow.update("blob", previous.id, (b) =>
                    b.set({ ...values, updatedAt: uow.now() }).check(),
                  );
                  uow.triggerHook("deleteObject", { objectKey: previous.objectKey });
                } else {
                  uow.create("blob", values, {
                    // Another upload of the same key may complete concurrently; the retry replaces
                    // the blob it created.
                    retryOnUniqueConflict: ({ error }) => error.kind === "unique",
                  });
                }
                const blob = toBlob(values);
                uow.triggerHook("onBlobStored", blob);
                return blob;
              })
              .execute();

            return json(blob);
          } catch (cause) {
            if (cause instanceof BlobsError) {
              return error({ message: cause.message, code: cause.code }, ERROR_STATUS[cause.code]);
            }
            throw cause;
          }
        },
      }),

      defineRoute({
        method: "GET",
        path: "/blobs",
        queryParameters: ["prefix", "cursor", "pageSize"],
        outputSchema: z.object({ blobs: z.array(blobSchema), cursor: z.string().nullable() }),
        handler: async function ({ query }, { json }) {
          const prefix = query.get("prefix") ?? "";
          const cursor = query.get("cursor");
          const pageSize = Math.min(
            Number.parseInt(query.get("pageSize") ?? "", 10) || DEFAULT_PAGE_SIZE,
            MAX_PAGE_SIZE,
          );

          const page = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(blobsSchema).findWithCursor("blob", (b) => {
                const ordered = b
                  .whereIndex("idx_blob_key", (eb) => eb("key", "starts with", prefix))
                  .orderByIndex("idx_blob_key", "asc")
                  .pageSize(pageSize);
                return cursor ? ordered.after(cursor) : ordered;
              }),
            )
            .transformRetrieve(([result]) => result)
            .execute();

          return json({
            blobs: page.items.map(toBlob),
            cursor: page.hasNextPage && page.cursor ? page.cursor.encode() : null,
          });
        },
      }),

      defineRoute({
        method: "GET",
        path: "/blobs/by-key",
        queryParameters: ["key"],
        outputSchema: blobSchema,
        errorCodes,
        handler: async function ({ query }, { json, error }) {
          const key = blobKeyQuery(query);
          if (key === null) {
            return error({ message: "The blob key is invalid.", code: "INVALID_KEY" }, 400);
          }
          const blob = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(blobsSchema).findFirst("blob", (b) =>
                b.whereIndex("idx_blob_key", (eb) => eb("key", "=", key)),
              ),
            )
            .transformRetrieve(([result]) => result)
            .execute();
          if (!blob) {
            return error({ message: "The blob does not exist.", code: "BLOB_NOT_FOUND" }, 404);
          }
          return json(toBlob(blob));
        },
      }),

      defineRoute({
        method: "GET",
        path: "/blobs/by-key/download-url",
        queryParameters: ["key"],
        outputSchema: z.object({ url: z.string(), expiresAt: z.date() }),
        errorCodes,
        handler: async function ({ query }, { json, error }) {
          const key = blobKeyQuery(query);
          if (key === null) {
            return error({ message: "The blob key is invalid.", code: "INVALID_KEY" }, 400);
          }
          const blob = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(blobsSchema).findFirst("blob", (b) =>
                b.whereIndex("idx_blob_key", (eb) => eb("key", "=", key)),
              ),
            )
            .transformRetrieve(([result]) => result)
            .execute();
          if (!blob) {
            return error({ message: "The blob does not exist.", code: "BLOB_NOT_FOUND" }, 404);
          }

          const expiresAt = new Date(Date.now() + DOWNLOAD_URL_EXPIRES_IN_SECONDS * 1000);
          try {
            const url = await config.storage.createDownloadUrl({
              objectKey: blob.objectKey,
              expiresInSeconds: DOWNLOAD_URL_EXPIRES_IN_SECONDS,
            });
            return json({ url, expiresAt });
          } catch {
            return error({ message: "Storage error", code: "STORAGE_ERROR" }, 502);
          }
        },
      }),

      defineRoute({
        method: "GET",
        path: "/blobs/by-key/range",
        queryParameters: ["key", "offset", "length"],
        errorCodes,
        handler: async function ({ query }, { error }) {
          const key = blobKeyQuery(query);
          if (key === null) {
            return error({ message: "The blob key is invalid.", code: "INVALID_KEY" }, 400);
          }
          const offset = integerQuery(query, "offset");
          const length = integerQuery(query, "length");
          if (offset === null || length === null || length < 1 || length > BLOBS_MAX_RANGE_BYTES) {
            return error(
              {
                message: `Ranges start at a byte offset and span 1 to ${BLOBS_MAX_RANGE_BYTES} bytes.`,
                code: "INVALID_RANGE",
              },
              400,
            );
          }
          const blob = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(blobsSchema).findFirst("blob", (b) =>
                b.whereIndex("idx_blob_key", (eb) => eb("key", "=", key)),
              ),
            )
            .transformRetrieve(([result]) => result)
            .execute();
          if (!blob) {
            return error({ message: "The blob does not exist.", code: "BLOB_NOT_FOUND" }, 404);
          }
          const sizeBytes = Number(blob.sizeBytes);
          if (offset >= sizeBytes) {
            return error(
              {
                message: `The blob ends before byte ${offset}; it holds ${sizeBytes} bytes.`,
                code: "RANGE_NOT_SATISFIABLE",
              },
              416,
            );
          }

          const end = Math.min(offset + length, sizeBytes);
          let range;
          try {
            // The upload's URL can still overwrite the object after the upload completed, so only
            // bytes that still carry the recorded tag match the blob's size and tag.
            range = await config.storage.readObjectRange({
              objectKey: blob.objectKey,
              etag: blob.etag,
              offset,
              length: end - offset,
            });
          } catch {
            return error({ message: "Storage error", code: "STORAGE_ERROR" }, 502);
          }
          // Replacing or deleting the blob since it was read removes its object.
          if (range.status === "missing") {
            return error({ message: "The blob does not exist.", code: "BLOB_NOT_FOUND" }, 404);
          }
          if (range.status === "changed") {
            return error(
              {
                message: "Storage holds other bytes than the blob recorded.",
                code: "BLOB_CHANGED",
              },
              409,
            );
          }
          return new Response(range.bytes, {
            status: 206,
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Range": `bytes ${offset}-${end - 1}/${sizeBytes}`,
              // Tells readers combining several ranges whether they all came from the same bytes.
              ETag: `"${blob.etag}"`,
            },
          });
        },
      }),

      defineRoute({
        method: "DELETE",
        path: "/blobs/by-key",
        queryParameters: ["key"],
        outputSchema: z.object({ ok: z.literal(true) }),
        errorCodes,
        handler: async function ({ query }, { json, error }) {
          const key = blobKeyQuery(query);
          if (key === null) {
            return error({ message: "The blob key is invalid.", code: "INVALID_KEY" }, 400);
          }
          const deleted = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(blobsSchema).findFirst("blob", (b) =>
                b.whereIndex("idx_blob_key", (eb) => eb("key", "=", key)),
              ),
            )
            .mutate(({ forSchema, retrieveResult: [blob] }) => {
              if (!blob) {
                return false;
              }
              const uow = forSchema(blobsSchema);
              uow.delete("blob", blob.id, (b) => b.check());
              uow.triggerHook("deleteObject", { objectKey: blob.objectKey });
              uow.triggerHook("onBlobDeleted", toBlob(blob));
              return true;
            })
            .execute();
          if (!deleted) {
            return error({ message: "The blob does not exist.", code: "BLOB_NOT_FOUND" }, 404);
          }
          return json({ ok: true });
        },
      }),
    ];
  },
);
