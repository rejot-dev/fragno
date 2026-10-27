import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { isoDateTimeOutputSchema } from "./shared/datetime";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";

/** R2 accepts at most 5 GiB less 5 MiB in one PUT, and a blob uploads in one PUT. */
export const BLOB_MAX_SIZE_BYTES = 5 * 1024 ** 3 - 5 * 1024 ** 2;

const blobKeySchema = z.lazy(() =>
  z
    .string()
    .trim()
    .min(1)
    .max(512)
    .describe(
      "The blob's name within the scope, e.g. recordings/2026-10-26.mp4. Slash-separated segments, none empty, '.' or '..'.",
    ),
);

const blobSchema = z.lazy(() =>
  z.object({
    key: z.string(),
    sizeBytes: z.number(),
    contentType: z.string(),
  }),
);

export type Blob = z.output<typeof blobSchema>;

const blobUploadSchema = z.lazy(() =>
  z.object({
    uploadId: z.string().describe("Pass to blobs.completeUpload once the bytes are stored."),
    key: z.string(),
    url: z
      .string()
      .describe(
        "Presigned storage URL that accepts one PUT of the blob's bytes, from sandboxes or anywhere else.",
      ),
    headers: z
      .record(z.string(), z.string())
      .describe("Headers the PUT must send unchanged, as they are part of the signature."),
    expiresAt: isoDateTimeOutputSchema.describe(
      "The URL stops working, and an uncompleted upload is discarded, at this time.",
    ),
  }),
);

export type BlobUpload = z.output<typeof blobUploadSchema>;

const blobDownloadUrlSchema = z.lazy(() =>
  z.object({
    url: z.string().describe("Presigned storage URL; a GET returns the blob's bytes."),
    expiresAt: isoDateTimeOutputSchema,
  }),
);

export type BlobDownloadUrl = z.output<typeof blobDownloadUrlSchema>;

const blobPageSchema = z.lazy(() =>
  z.object({
    blobs: z.array(blobSchema),
    cursor: z
      .string()
      .nullable()
      .describe("Pass to blobs.list for the next page; null at the end."),
  }),
);

export type BlobPage = z.output<typeof blobPageSchema>;

export const blobsOperations = {
  "blobs.createUpload": {
    description: `Start storing a large file as a blob of this scope. Blobs are kept apart from /workspace files: state.* does not see them and their bytes never pass through Backoffice. Whoever holds the file PUTs its bytes to \`url\` with \`headers\` before \`expiresAt\`: the URL works from sandboxes, and can be given to people and services outside Backoffice. When the file is on the user's computer, give them that command with the URL and their file filled in, for example \`curl -sS --fail-with-body -X PUT -H "Content-Type: $contentType" -T file "$url"\`. Then call blobs.completeUpload. The size need not be known in advance; a blob may be at most ${BLOB_MAX_SIZE_BYTES} bytes. Creating another upload for the same key replaces an unfinished one, and completing it replaces the existing blob.`,
    permissions: [BACKOFFICE_PERMISSION.upload.modify],
    input: z.lazy(() =>
      z.strictObject({
        key: blobKeySchema,
        contentType: z.string().trim().min(1).default("application/octet-stream"),
      }),
    ),
    output: blobUploadSchema,
  },
  "blobs.completeUpload": {
    description:
      "Finish an upload after its bytes were PUT, and return the stored blob with its size. It fails when storage holds no bytes for the upload yet.",
    permissions: [BACKOFFICE_PERMISSION.upload.modify],
    input: z.lazy(() => z.strictObject({ uploadId: z.string().trim().min(1) })),
    output: blobSchema,
  },
  "blobs.get": {
    description: "Get a blob's metadata by key, or null when the scope has no such blob.",
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: z.lazy(() => z.strictObject({ key: blobKeySchema })),
    output: z.lazy(() => blobSchema.nullable()),
  },
  "blobs.list": {
    description:
      "List this scope's blobs by key, optionally only those whose key starts with prefix.",
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: z.lazy(() =>
      z.strictObject({
        prefix: z.string().optional(),
        cursor: z.string().optional(),
      }),
    ),
    output: blobPageSchema,
  },
  "blobs.createDownloadUrl": {
    description:
      "Create a temporary URL that reads a blob straight from storage without credentials. It works from sandboxes, browsers, and services outside Backoffice. Anyone holding the URL can read the blob until it expires.",
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: z.lazy(() => z.strictObject({ key: blobKeySchema })),
    output: blobDownloadUrlSchema,
  },
  "blobs.delete": {
    description: "Delete a blob and its stored bytes.",
    permissions: [BACKOFFICE_PERMISSION.upload.modify],
    input: z.lazy(() => z.strictObject({ key: blobKeySchema })),
    output: z.void(),
  },
} satisfies Record<string, BackofficeApiOperation>;
