import type { TableToColumnValues } from "@fragno-dev/db/query";
import { z } from "zod";

import { uploadSchema } from "../schema";
import type { FileMetadata, FileMutationResult } from "../types";

type FileRow = TableToColumnValues<typeof uploadSchema.tables.file>;
type FileMetadataSource = Omit<FileRow, "id"> & { id?: unknown };
type FileMutationResultSource = Pick<
  FileRow,
  | "key"
  | "uploaderId"
  | "filename"
  | "sizeBytes"
  | "contentType"
  | "checksum"
  | "visibility"
  | "tags"
  | "metadata"
  | "status"
  | "provider"
  | "errorCode"
  | "errorMessage"
>;

const checksumValueSchema = z.object({
  algo: z.enum(["sha256", "md5"]),
  value: z.string(),
});

export const checksumSchema = checksumValueSchema.nullable().optional();

export const providerNamespaceSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\"),
    {
      message: "Invalid provider",
    },
  );

export const visibilitySchema = z.enum(["private", "public", "unlisted"]);

export const fileWritePreconditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }),
  z.object({
    kind: z.literal("revision"),
    revision: z.number().int().nonnegative(),
  }),
]);

export const fileMetadataSchema = z.object({
  fileKey: z.string(),
  uploaderId: z.string().nullable(),
  filename: z.string(),
  sizeBytes: z.number(),
  contentType: z.string(),
  checksum: z
    .object({
      algo: z.enum(["sha256", "md5"]),
      value: z.string(),
    })
    .nullable(),
  visibility: visibilitySchema,
  tags: z.array(z.string()).nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  status: z.enum(["ready", "deleted"]),
  provider: providerNamespaceSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
});

export const fileMutationResultSchema = fileMetadataSchema.omit({
  createdAt: true,
  updatedAt: true,
  completedAt: true,
  deletedAt: true,
});

export const fileSnapshotSchema = fileMetadataSchema.extend({
  revision: z.number().int().nonnegative(),
});

export const fileMutationSnapshotSchema = fileMutationResultSchema.extend({
  revision: z.number().int().nonnegative(),
});

export const preparedFileWriteSchema = z.object({
  uploadId: z.string(),
  provider: providerNamespaceSchema,
  fileKey: z.string(),
  objectKey: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  contentType: z.string(),
  checksum: checksumValueSchema.nullable(),
  expiresAt: z.iso.datetime(),
});

export const uploadCompletionResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("published"),
    file: fileMutationResultSchema,
  }),
  z.object({
    kind: z.literal("prepared"),
    write: preparedFileWriteSchema,
  }),
]);

export const toFileMutationResult = (file: FileMutationResultSource): FileMutationResult => ({
  fileKey: file.key,
  uploaderId: file.uploaderId,
  filename: file.filename,
  sizeBytes: Number(file.sizeBytes),
  contentType: file.contentType,
  checksum: file.checksum,
  visibility: file.visibility as FileMutationResult["visibility"],
  tags: file.tags,
  metadata: file.metadata,
  status: file.status as FileMutationResult["status"],
  provider: file.provider,
  errorCode: file.errorCode,
  errorMessage: file.errorMessage,
});

export const toFileMetadata = (file: FileMetadataSource): FileMetadata => {
  const toIsoString = (value: Date | null | undefined) => (value ? value.toISOString() : null);

  return {
    fileKey: file.key,
    uploaderId: file.uploaderId,
    filename: file.filename,
    sizeBytes: Number(file.sizeBytes),
    contentType: file.contentType,
    checksum: file.checksum,
    visibility: file.visibility as FileMetadata["visibility"],
    tags: file.tags,
    metadata: file.metadata,
    status: file.status as FileMetadata["status"],
    provider: file.provider,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
    completedAt: toIsoString(file.completedAt),
    deletedAt: toIsoString(file.deletedAt),
    errorCode: file.errorCode,
    errorMessage: file.errorMessage,
  };
};
