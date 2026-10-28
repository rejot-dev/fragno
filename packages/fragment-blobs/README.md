# Blobs Fragment

Large files for Fragno, kept in an S3-compatible bucket such as Cloudflare R2. Callers move bytes
straight to and from storage through presigned URLs; the fragment records each blob's key, size,
content type, and ETag, and deletes objects nobody needs anymore.

For files that fit in database rows, with search, edits, and atomic batches, use
`@fragno-dev/upload`.

```ts
import { createBlobsFragment, createS3BlobStorage } from "@fragno-dev/blobs";

const blobs = createBlobsFragment(
  {
    storage: createS3BlobStorage({
      endpoint: "https://<account>.r2.cloudflarestorage.com",
      bucket: "blobs",
      pathStyle: true,
      // Signs requests with AWS Signature Version 4, e.g. with aws4fetch.
      signer,
      fetch,
    }),
    // Prefixes every object key, so several fragments can share one bucket.
    storageKeyPrefix: "tenant-1",
    // Durable: each runs after its change commits, and may run more than once.
    onBlobStored: async (blob, idempotencyKey) => {
      await startTranscription(blob.key, { idempotencyKey });
    },
    onBlobDeleted: async (blob, idempotencyKey) => {},
  },
  { databaseAdapter, mountRoute: "/api/blobs" },
);
```

## Routes

| Route                                  | Behavior                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `POST /uploads`                        | `{ key, contentType }` → a presigned PUT `url`, its `headers`, `uploadId` |
| `POST /uploads/:uploadId/complete`     | Records what storage holds as the key's blob, replacing any earlier one   |
| `GET /blobs?prefix=&cursor=&pageSize=` | Blobs by key, a page at a time                                            |
| `GET /blobs/by-key?key=`               | One blob's key, size, content type, and ETag                              |
| `GET /blobs/by-key/download-url?key=`  | A presigned GET URL                                                       |
| `DELETE /blobs/by-key?key=`            | Deletes the blob and its object                                           |

An upload's URL accepts one PUT for an hour, and completion stays open for another hour, so a PUT
that started in time may finish late. The uploader need not know the size in advance: completion
reads it and the ETag from storage, and fails with `UPLOAD_CONTENT_MISSING` until the bytes arrive.
Creating another upload for the same key replaces an unfinished one. Every upload writes its own
object, so neither an unfinished upload nor a replacement touches the object a download URL reads.

A download URL ends in the last segment of the blob's key, so browsers save the file under its name.
Storage serves the bytes with the content type they were uploaded with, so browsers show some types,
such as videos, in place.

`onBlobStored` runs for a new blob and for a replacement; `onBlobDeleted` runs only for
`DELETE /blobs/by-key`. Both receive the blob as `GET /blobs/by-key` returns it.

Durable hooks delete objects nobody references: a replaced or deleted blob's object once the change
commits, and an unfinished upload's object once its URL can no longer write it.
