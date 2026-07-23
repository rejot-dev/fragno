export type UploadFileRecord = {
  provider: string;
  fileKey: string;
  status: string;
  uploaderId?: string | null;
  uploadId?: string | null;
  sizeBytes: number;
  filename: string;
  contentType: string;
  checksumAlgo?: string | null;
  checksumValue?: string | null;
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
  tags: (file.tags as string[] | null) ?? undefined,
  metadata: file.metadata as Record<string, unknown> | null,
  visibility: file.visibility,
  createdAt: file.createdAt,
  updatedAt: file.updatedAt,
  deletedAt: file.deletedAt,
});
