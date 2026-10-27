import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";

import { blobsSchema } from "./schema";
import type { BlobStorage } from "./storage";

/** A blob as callers and hooks see it. */
export type StoredBlob = {
  key: string;
  sizeBytes: number;
  contentType: string;
  /** Storage's tag for the blob's bytes; it changes whenever the bytes do. */
  etag: string;
};

export interface BlobsFragmentConfig {
  storage: BlobStorage;
  /** Prefixes every object key, so several fragments can keep their blobs in one bucket. */
  storageKeyPrefix: string;
  /**
   * Runs, durably and possibly more than once, after an upload stores a blob or replaces the one at
   * its key.
   */
  onBlobStored?: (blob: StoredBlob, idempotencyKey: string) => Promise<void>;
  /** Runs, durably and possibly more than once, after a blob is deleted. */
  onBlobDeleted?: (blob: StoredBlob, idempotencyKey: string) => Promise<void>;
}

export type UnfinishedUpload = { uploadId: string; key: string; objectKey: string };

export const blobsFragmentDefinition = defineFragment<BlobsFragmentConfig>("blobs")
  .extend(withDatabase(blobsSchema))
  .provideHooks(({ defineHook, config }) => ({
    onBlobStored: defineHook(async function (blob: StoredBlob) {
      await config.onBlobStored?.(blob, this.idempotencyKey);
    }),
    onBlobDeleted: defineHook(async function (blob: StoredBlob) {
      await config.onBlobDeleted?.(blob, this.idempotencyKey);
    }),
    deleteObject: defineHook(async function ({ objectKey }: { objectKey: string }) {
      await config.storage.deleteObject(objectKey);
    }),
    discardUnfinishedUpload: defineHook(async function ({
      uploadId,
      key,
      objectKey,
    }: UnfinishedUpload) {
      const published = await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(blobsSchema)
            .findFirst("blob_upload", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", uploadId)),
            )
            .findFirst("blob", (b) => b.whereIndex("idx_blob_key", (eb) => eb("key", "=", key))),
        )
        .mutate(({ forSchema, retrieveResult: [upload, blob] }) => {
          if (upload) {
            forSchema(blobsSchema).delete("blob_upload", upload.id, (b) => b.check());
          }
          return blob?.objectKey === objectKey;
        })
        .execute();

      // The upload has expired, so it can no longer become its key's blob, and whatever its URL
      // stored is garbage unless the upload already did.
      if (!published) {
        await config.storage.deleteObject(objectKey);
      }
    }),
  }))
  .build();
