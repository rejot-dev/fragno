export type FileVisibility = "private" | "public" | "unlisted";

export type FileStatus = "ready" | "deleted";

export type UploadFileWritePrecondition =
  | { kind: "absent" }
  | { kind: "revision"; revision: number };

export type UploadStatus =
  | "created"
  | "in_progress"
  | "prepared"
  | "completed"
  | "aborted"
  | "failed"
  | "expired";

export type UploadPublicationMode = "immediate" | "batch";

export type UploadStrategy = "direct-single" | "direct-multipart" | "proxy";

export type PreparedFileWrite = {
  uploadId: string;
  provider: string;
  fileKey: string;
  objectKey: string;
  sizeBytes: number;
  contentType: string;
  checksum: { algo: "sha256" | "md5"; value: string } | null;
  expiresAt: string;
};

export type PreparedFileBatchEntry =
  | {
      kind: "write";
      uploadId: string;
      precondition?: UploadFileWritePrecondition;
    }
  | {
      kind: "delete";
      provider: string;
      fileKey: string;
      precondition: Extract<UploadFileWritePrecondition, { kind: "revision" }>;
    }
  | {
      kind: "assert";
      provider: string;
      fileKey: string;
      precondition: UploadFileWritePrecondition;
    };

export type FileMetadata = {
  fileKey: string;
  uploaderId: string | null;
  filename: string;
  sizeBytes: number;
  contentType: string;
  checksum: { algo: "sha256" | "md5"; value: string } | null;
  visibility: FileVisibility;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
  status: FileStatus;
  provider: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  deletedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type FileMutationResult = Omit<
  FileMetadata,
  "createdAt" | "updatedAt" | "completedAt" | "deletedAt"
>;

export type UploadCompletionResult =
  | { kind: "published"; file: FileMutationResult }
  | { kind: "prepared"; write: PreparedFileWrite };

export type UploadFileSnapshot = FileMetadata & { revision: number };
export type UploadFileMutationSnapshot = FileMutationResult & { revision: number };

export type PreparedFileBatchCommitResult = {
  files: UploadFileMutationSnapshot[];
};
