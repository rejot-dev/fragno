import { z } from "zod";

import { checksumSchema, providerNamespaceSchema } from "./shared";

const uploadPublicationModeSchema = z.enum(["immediate", "batch"]);

export const createUploadInputSchema = z.object({
  provider: providerNamespaceSchema,
  keyParts: z.array(z.union([z.string(), z.number().int()])).optional(),
  fileKey: z.string().optional(),
  filename: z.string().min(1),
  sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  contentType: z.string().min(1),
  checksum: checksumSchema.optional(),
  tags: z.array(z.string()).optional(),
  visibility: z.enum(["private", "public", "unlisted"]).optional(),
  uploaderId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  publicationMode: uploadPublicationModeSchema.optional(),
  /**
   * Aborts unfinished uploads of the same file key instead of rejecting this one with
   * `UPLOAD_ALREADY_ACTIVE`, so the newest upload wins.
   */
  replaceActiveUpload: z.boolean().optional(),
});

export const createUploadOutputSchema = z.object({
  uploadId: z.string(),
  fileKey: z.string(),
  provider: z.string(),
  status: z.enum(["created", "in_progress"]),
  publicationMode: uploadPublicationModeSchema,
  expiresAt: z.date(),
});

export const uploadStatusOutputSchema = z.object({
  uploadId: z.string(),
  fileKey: z.string(),
  provider: z.string(),
  status: z.enum([
    "created",
    "in_progress",
    "prepared",
    "completed",
    "aborted",
    "failed",
    "expired",
  ]),
  publicationMode: uploadPublicationModeSchema,
  expectedSizeBytes: z.number(),
  bytesUploaded: z.number(),
  expiresAt: z.date(),
  createdAt: z.date(),
  updatedAt: z.date(),
  completedAt: z.date().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
});

export const abortUploadOutputSchema = z.object({ ok: z.literal(true) });
