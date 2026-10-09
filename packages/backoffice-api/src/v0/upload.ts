import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { base64BytesSchema } from "./shared/bytes";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";
import { backofficeRoutableScopeSchema } from "./shared/scope";

export const preparedUploadedFileReferenceSchema = z.strictObject({
  kind: z.literal("prepared-upload"),
  scope: backofficeRoutableScopeSchema,
  uploadId: z.string().min(1).max(240),
  provider: z.string().min(1).max(120),
  fileKey: z.string().min(1).max(1_024),
  filename: z.string().min(1).max(500),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  contentType: z.string().min(1).max(240),
  expiresAt: z.iso.datetime(),
});

export const uploadPreparedInputSchema = z.object({
  file: preparedUploadedFileReferenceSchema,
});

export type PreparedUploadedFileReference = z.infer<typeof preparedUploadedFileReferenceSchema>;

export const uploadedFileReferenceSchema = preparedUploadedFileReferenceSchema
  .omit({ kind: true, expiresAt: true })
  .extend({ kind: z.literal("uploaded-file") });

export type UploadedFileReference = z.infer<typeof uploadedFileReferenceSchema>;

export const uploadDiscardPreparedOutputSchema = z.object({
  discarded: z.literal(true),
  uploadId: z.string().trim().min(1),
});

const uploadReadPreparedOutputFields = {
  file: preparedUploadedFileReferenceSchema,
  byteLength: z.number().int().nonnegative(),
};

export const uploadOperations = {
  "upload.prepared.read": {
    description: "Read one prepared private upload as UTF-8 text or base64-encoded bytes.",
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: z.object({
      file: preparedUploadedFileReferenceSchema,
      encoding: z.enum(["utf8", "base64"]).optional(),
      maxBytes: z
        .number()
        .int()
        .positive()
        .max(50 * 1_024 * 1_024)
        .optional(),
    }),
    output: z.discriminatedUnion("encoding", [
      z.object({
        ...uploadReadPreparedOutputFields,
        encoding: z.literal("utf8"),
        text: z.string(),
      }),
      z.object({
        ...uploadReadPreparedOutputFields,
        encoding: z.literal("base64"),
        base64: base64BytesSchema,
      }),
    ]),
  },
  "upload.prepared.commit": {
    description: "Commit a prepared private upload so the file persists.",
    permissions: [BACKOFFICE_PERMISSION.upload.modify],
    input: uploadPreparedInputSchema,
    output: uploadedFileReferenceSchema,
  },
  "upload.prepared.discard": {
    description: "Discard a temporary prepared private upload.",
    permissions: [BACKOFFICE_PERMISSION.upload.modify],
    input: uploadPreparedInputSchema,
    output: uploadDiscardPreparedOutputSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
