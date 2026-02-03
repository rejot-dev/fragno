export type FileVisibility = "private" | "public" | "unlisted";

export type FileStatus = "ready" | "deleted";

export type UploadStatus =
  | "created"
  | "in_progress"
  | "completed"
  | "aborted"
  | "failed"
  | "expired";

export type UploadStrategy = "direct-single" | "direct-multipart" | "proxy";

export type FileMetadata = {
  fileKey: string;
  fileKeyParts: (string | number)[];
  uploaderId: string | null;
  filename: string;
  sizeBytes: number;
  contentType: string;
  checksum: { algo: "sha256" | "md5"; value: string } | null;
  visibility: FileVisibility;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
  status: FileStatus;
  storageProvider: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  deletedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};
