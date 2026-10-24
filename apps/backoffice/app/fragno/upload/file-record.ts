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
