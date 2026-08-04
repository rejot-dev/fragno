import { z } from "zod";

import { backofficeRoutableScopeSchema } from "@/backoffice-runtime/context-schema";

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

export type PreparedUploadedFileReference = z.infer<typeof preparedUploadedFileReferenceSchema>;

export const uploadedFileReferenceSchema = preparedUploadedFileReferenceSchema
  .omit({ kind: true, expiresAt: true })
  .extend({ kind: z.literal("uploaded-file") });

export type UploadedFileReference = z.infer<typeof uploadedFileReferenceSchema>;
