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

const uploadProviderSchema = z
  .enum(["database", "r2", "r2-binding"])
  .meta({ id: "UploadProvider" });

export const uploadStorageSchema = z
  .strictObject({
    defaultProvider: uploadProviderSchema
      .nullable()
      .describe("The provider new uploads use; null until one is configured."),
    providers: z.array(uploadProviderSchema).describe("Providers with stored configuration."),
  })
  .meta({ id: "UploadStorage" });

const uploadStorageDefaultSchema = z
  .boolean()
  .describe("Whether new uploads use this provider. Files already stored stay where they are.");

export const uploadStorageConfigureInputSchema = z
  .discriminatedUnion("provider", [
    z.strictObject({
      provider: z.literal("database").describe("Files stored in Backoffice's own database."),
      default: uploadStorageDefaultSchema,
    }),
    z.strictObject({
      provider: z.literal("r2-binding").describe("An R2 bucket bound to the Worker."),
      bindingName: z.string().trim().min(1).describe("Name of the Worker's R2 bucket binding."),
      default: uploadStorageDefaultSchema,
    }),
    z.strictObject({
      provider: z.literal("r2").describe("An R2 bucket reached through its S3 API."),
      bucket: z.string().trim().min(1),
      endpoint: z.url().describe("The account's S3 API endpoint."),
      accessKeyId: z.string().trim().min(1).describe("Secret."),
      secretAccessKey: z.string().trim().min(1).describe("Secret."),
      region: z.string().trim().min(1).describe("Usually auto."),
      sessionToken: z.string().trim().min(1).nullable().describe("Secret; null when unused."),
      pathStyle: z.boolean().describe("Address the bucket in the path rather than the host name."),
      default: uploadStorageDefaultSchema,
    }),
  ])
  .meta({ id: "UploadStorageConfigureInput" });

export const uploadOperations = {
  "upload.storage.get": {
    description:
      "Read the organization's upload storage: the configured providers and the one new uploads use.",
    permissions: [BACKOFFICE_PERMISSION.connections.read],
    input: z.void(),
    output: uploadStorageSchema,
  },
  "upload.storage.configure": {
    description:
      "Store one upload storage provider's configuration for the organization, replacing that provider's earlier configuration. Secrets are never returned.",
    permissions: [BACKOFFICE_PERMISSION.connections.manage],
    input: uploadStorageConfigureInputSchema,
    output: uploadStorageSchema,
  },
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
