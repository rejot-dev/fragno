import type { TableToColumnValues } from "@fragno-dev/db/query";
import { z } from "zod";

import { uploadSchema } from "../schema";
import type { FileMetadata } from "../types";

type FileRow = TableToColumnValues<typeof uploadSchema.tables.file>;
type FileMetadataSource = Omit<FileRow, "id"> & { id?: unknown };

export const checksumSchema = z
  .object({
    algo: z.enum(["sha256", "md5"]),
    value: z.string(),
  })
  .nullable()
  .optional();

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

export const toFileMetadata = (file: FileMetadataSource): FileMetadata => {
  const toIsoString = (value: Date | null | undefined) => (value ? value.toISOString() : null);

  return {
    fileKey: file.key,
    uploaderId: file.uploaderId,
    filename: file.filename,
    sizeBytes: Number(file.sizeBytes),
    contentType: file.contentType,
    checksum: file.checksum as FileMetadata["checksum"],
    visibility: file.visibility as FileMetadata["visibility"],
    tags: file.tags as FileMetadata["tags"],
    metadata: file.metadata as FileMetadata["metadata"],
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
