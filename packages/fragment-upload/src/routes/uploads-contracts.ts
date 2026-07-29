import { z } from "zod";

import { checksumSchema, providerNamespaceSchema } from "./shared";

const uploadStrategySchema = z.enum(["direct-single", "direct-multipart", "proxy"]);
const uploadPublicationModeSchema = z.enum(["immediate", "batch"]);

const uploadRouteDataSchema = z.object({
  provider: z.string(),
  upload: z.object({
    mode: z.enum(["single", "multipart"]),
    transport: z.enum(["direct", "proxy"]),
    uploadUrl: z.string().optional(),
    uploadHeaders: z.record(z.string(), z.string()).optional(),
    partSizeBytes: z.number().optional(),
    maxParts: z.number().optional(),
    statusEndpoint: z.string(),
    progressEndpoint: z.string(),
    partsEndpoint: z.string().optional(),
    partsCompleteEndpoint: z.string().optional(),
    completeEndpoint: z.string(),
    abortEndpoint: z.string(),
    contentEndpoint: z.string().optional(),
  }),
});

export const createUploadInputSchema = z.object({
  provider: providerNamespaceSchema.optional(),
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
});

export const createUploadOutputSchema = uploadRouteDataSchema.extend({
  uploadId: z.string(),
  fileKey: z.string(),
  status: z.enum(["created", "in_progress"]),
  strategy: uploadStrategySchema,
  publicationMode: uploadPublicationModeSchema,
  expiresAt: z.date(),
});

export const uploadStatusOutputSchema = uploadRouteDataSchema.extend({
  uploadId: z.string(),
  fileKey: z.string(),
  status: z.enum([
    "created",
    "in_progress",
    "prepared",
    "completed",
    "aborted",
    "failed",
    "expired",
  ]),
  strategy: uploadStrategySchema,
  publicationMode: uploadPublicationModeSchema,
  expectedSizeBytes: z.number(),
  bytesUploaded: z.number(),
  partsUploaded: z.number(),
  partSizeBytes: z.number().nullable(),
  expiresAt: z.date(),
  createdAt: z.date(),
  updatedAt: z.date(),
  completedAt: z.date().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
});

export const uploadProgressInputSchema = z.object({
  bytesUploaded: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  partsUploaded: z.number().int().min(0).optional(),
});

export const uploadProgressOutputSchema = z.object({
  bytesUploaded: z.number(),
  partsUploaded: z.number(),
});

export const uploadPartNumbersInputSchema = z.object({
  partNumbers: z.array(z.number().int().min(1)).min(1),
});

export const uploadPartUrlsOutputSchema = z.object({
  parts: z.array(
    z.object({
      partNumber: z.number(),
      url: z.string(),
      headers: z.record(z.string(), z.string()).optional(),
    }),
  ),
});

export const completedUploadPartsInputSchema = z.object({
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().min(1),
        etag: z.string().min(1),
        sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .min(1),
});

export const uploadPartsOutputSchema = z.object({
  parts: z.array(
    z.object({
      partNumber: z.number(),
      etag: z.string(),
      sizeBytes: z.number(),
      createdAt: z.date(),
    }),
  ),
});

export const completeUploadInputSchema = z.strictObject({
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().min(1),
        etag: z.string().min(1),
      }),
    )
    .optional(),
});

export const abortUploadOutputSchema = z.object({ ok: z.literal(true) });
