import type { UploadChecksum } from "@fragno-dev/upload";

export type UploadFileRecord = {
  provider: string;
  fileKey: string;
  revision?: number;
  status: string;
  uploaderId?: string | null;
  uploadId?: string | null;
  sizeBytes: number;
  filename: string;
  contentType: string;
  checksum?: UploadChecksum | null;
  tags?: string[];
  metadata?: Record<string, unknown> | null;
  visibility?: string | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  deletedAt?: string | Date | null;
};

type SynchronizedUploadFileRow = {
  provider: string;
  key: string;
  status: string;
  uploaderId: string | null;
  sizeBytes: number | bigint;
  filename: string;
  contentType: string;
  checksum: unknown;
  tags: unknown;
  metadata: unknown;
  visibility: string;
  createdAt: string | Date;
  updatedAt: string | Date;
  deletedAt: string | Date | null;
};

export const toUploadFileRecord = (file: SynchronizedUploadFileRow): UploadFileRecord => ({
  provider: file.provider,
  fileKey: file.key,
  status: file.status,
  uploaderId: file.uploaderId,
  sizeBytes: Number(file.sizeBytes),
  filename: file.filename,
  contentType: file.contentType,
  checksum: file.checksum as UploadChecksum | null,
  tags: (file.tags as string[] | null) ?? undefined,
  metadata: file.metadata as Record<string, unknown> | null,
  visibility: file.visibility,
  createdAt: file.createdAt,
  updatedAt: file.updatedAt,
  deletedAt: file.deletedAt,
});
