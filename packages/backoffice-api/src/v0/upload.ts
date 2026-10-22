import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { base64BytesSchema } from "./shared/bytes";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";
import { backofficeRoutableScopeSchema } from "./shared/scope";

export const preparedUploadedFileReferenceSchema = z.lazy(() =>
  z.strictObject({
    kind: z.literal("prepared-upload"),
    scope: backofficeRoutableScopeSchema,
    uploadId: z.string().min(1).max(240),
    provider: z.string().min(1).max(120),
    fileKey: z.string().min(1).max(1_024),
    filename: z.string().min(1).max(500),
    sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    contentType: z.string().min(1).max(240),
    expiresAt: z.iso.datetime(),
  }),
);

export const uploadPreparedInputSchema = z.lazy(() =>
  z.object({
    file: preparedUploadedFileReferenceSchema,
  }),
);

export type PreparedUploadedFileReference = z.infer<typeof preparedUploadedFileReferenceSchema>;

export const uploadedFileReferenceSchema = z.lazy(() =>
  preparedUploadedFileReferenceSchema._zod.innerType
    .omit({ kind: true, expiresAt: true })
    .extend({ kind: z.literal("uploaded-file") }),
);

export type UploadedFileReference = z.infer<typeof uploadedFileReferenceSchema>;

export const uploadDiscardPreparedOutputSchema = z.lazy(() =>
  z.object({
    discarded: z.literal(true),
    uploadId: z.string().trim().min(1),
  }),
);

const uploadReadPreparedOutputFields = {
  file: preparedUploadedFileReferenceSchema,
  byteLength: z.lazy(() => z.number().int().nonnegative()),
};

const uploadProviderSchema = z
  .lazy(() => z.enum(["database", "r2", "r2-binding"]))
  .meta({
    id: "UploadProvider",
  });

export const uploadStorageSchema = z
  .lazy(() =>
    z.strictObject({
      defaultProvider: uploadProviderSchema
        .nullable()
        .describe("The provider new uploads use; null until one is configured."),
      providers: z.array(uploadProviderSchema).describe("Providers with stored configuration."),
    }),
  )
  .meta({ id: "UploadStorage" });

const uploadStorageDefaultSchema = z.lazy(() =>
  z
    .boolean()
    .describe("Whether new uploads use this provider. Files already stored stay where they are."),
);

export const uploadStorageConfigureInputSchema = z
  .lazy(() =>
    z.discriminatedUnion("provider", [
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
        pathStyle: z
          .boolean()
          .describe("Address the bucket in the path rather than the host name."),
        default: uploadStorageDefaultSchema,
      }),
    ]),
  )
  .meta({ id: "UploadStorageConfigureInput" });

const fileLinkInputSchema = z.lazy(() =>
  z.object({
    path: z
      .string()
      .trim()
      .min(1)
      .describe(
        "A /workspace file path, a folder ending in /, or a glob with * or ?, for example /workspace/data/*.csv.",
      ),
    expiresInSeconds: z
      .number()
      .int()
      .min(60)
      .max(3_600)
      .optional()
      .describe("How long the link works. Defaults to 900 seconds."),
  }),
);

const fileLinkSchema = z.lazy(() =>
  z.discriminatedUnion("format", [
    z.object({
      format: z.literal("file").describe("The URL's body is the file itself."),
      url: z
        .string()
        .describe(
          "Use unchanged in a sandbox command; its host may resolve only inside sandboxes.",
        ),
      path: z.string(),
      expiresAt: z.iso.datetime(),
    }),
    z.object({
      format: z.literal("tar").describe("The URL's body is a tar archive of the matching files."),
      url: z
        .string()
        .describe(
          "Use unchanged in a sandbox command; its host may resolve only inside sandboxes.",
        ),
      glob: z.string(),
      root: z.string().describe("The /workspace folder that archive entry names are relative to."),
      expiresAt: z.iso.datetime(),
    }),
  ]),
);

export type FileLinkInput = z.output<typeof fileLinkInputSchema>;
export type FileLink = z.output<typeof fileLinkSchema>;

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
    input: z.lazy(() =>
      z.object({
        file: preparedUploadedFileReferenceSchema,
        encoding: z.enum(["utf8", "base64"]).optional(),
        maxBytes: z
          .number()
          .int()
          .positive()
          .max(50 * 1_024 * 1_024)
          .optional(),
      }),
    ),
    output: z.lazy(() =>
      z.discriminatedUnion("encoding", [
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
    ),
  },
  "upload.prepared.commit": {
    description: "Commit a prepared private upload so the file persists.",
    permissions: [BACKOFFICE_PERMISSION.upload.modify],
    input: uploadPreparedInputSchema,
    output: uploadedFileReferenceSchema,
  },
  "upload.createDownloadLink": {
    description:
      'Create a temporary URL that sandbox commands use to read workspace files without credentials; it may not work outside sandboxes. A file path links the file: `curl -sS --fail-with-body "$url" -o file`. A folder or glob links an uncompressed tar archive of up to 500 matching files named relative to `root`: `curl -sS --fail-with-body "$url" | tar -x -C dir`. When the archive response has an X-Next-Cursor header, request the URL again with ?cursor=<value> for the next files. Anyone holding the URL can read these files until it expires.',
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: fileLinkInputSchema,
    output: fileLinkSchema,
  },
  "upload.createUploadLink": {
    description:
      'Create a temporary URL that sandbox commands use to write workspace files without credentials; it may not work outside sandboxes. Writes replace existing files. Each file may be at most 1.9 MB. A file path accepts the file: `curl -sS --fail-with-body -H "Expect:" -T file "$url"`. A folder or glob accepts an uncompressed tar archive of at most 200 regular files and 25 MB, without symlinks, whose entry names are relative to `root` and must match: `tar -ch -C dir . | curl -sS --fail-with-body -H "Expect:" -T - "$url"`. Push only the files the task produced, never a whole project; an archive is written all-or-nothing. A successful write returns `{"fileCount","sizeBytes"}`. Anyone holding the URL can write these files until it expires.',
    permissions: [BACKOFFICE_PERMISSION.upload.modify],
    input: fileLinkInputSchema,
    output: fileLinkSchema,
  },
  "upload.prepared.discard": {
    description: "Discard a temporary prepared private upload.",
    permissions: [BACKOFFICE_PERMISSION.upload.modify],
    input: uploadPreparedInputSchema,
    output: uploadDiscardPreparedOutputSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
