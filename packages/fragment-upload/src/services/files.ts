import type { DatabaseServiceContext } from "@fragno-dev/db";

import type {
  FileHookPayload,
  UploadFragmentResolvedConfig,
  UploadTimeoutPayload,
} from "../config";
import { uploadSchema } from "../schema";
import type { FileStatus } from "../types";
import { UploadServiceError } from "./errors";

export type FileByKeyInput = {
  provider: string;
  fileKey: string;
};

export type ListFilesInput = {
  provider?: string;
  prefix?: string;
  pageSize: number;
  cursor?: string;
  status?: FileStatus;
  uploaderId?: string;
};

export type UpdateFileInput = {
  filename?: string;
  visibility?: string;
  tags?: string[] | null;
  metadata?: Record<string, unknown> | null;
};

type FileHookSource = {
  provider: string;
  key: string;
  uploaderId?: string | null;
  sizeBytes: bigint | number;
  contentType: string;
  objectKey: string;
};

type UploadHooks = {
  onFileReady: (payload: FileHookPayload) => void | Promise<void>;
  onUploadFailed: (payload: FileHookPayload) => void | Promise<void>;
  onFileDeleted: (payload: FileHookPayload) => void | Promise<void>;
  cleanupStorageObject: (payload: FileHookPayload) => void | Promise<void>;
  onUploadTimeout: (payload: UploadTimeoutPayload) => void | Promise<void>;
};

type UploadServiceContext = DatabaseServiceContext<UploadHooks>;

const buildFileHookPayload = (file: FileHookSource, uploadId?: string): FileHookPayload => ({
  provider: file.provider,
  fileKey: file.key,
  objectKey: file.objectKey,
  uploadId,
  uploaderId: file.uploaderId,
  sizeBytes: Number(file.sizeBytes),
  contentType: file.contentType,
});

export const createFileServices = (_config: UploadFragmentResolvedConfig) => {
  return {
    findFileByKey: function (this: UploadServiceContext, input: FileByKeyInput) {
      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.findFirst("file", (b) =>
            b.whereIndex("idx_file_provider_key", (eb) =>
              eb.and(eb("provider", "=", input.provider), eb("key", "=", input.fileKey)),
            ),
          ),
        )
        .transformRetrieve(([file]) => file ?? null)
        .build();
    },

    getFileByKey: function (this: UploadServiceContext, input: FileByKeyInput) {
      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.findFirst("file", (b) =>
            b.whereIndex("idx_file_provider_key", (eb) =>
              eb.and(eb("provider", "=", input.provider), eb("key", "=", input.fileKey)),
            ),
          ),
        )
        .transformRetrieve(([file]) => {
          if (!file) {
            throw new UploadServiceError("FILE_NOT_FOUND", "The file does not exist.");
          }
          return file;
        })
        .build();
    },

    listFiles: function (this: UploadServiceContext, input: ListFilesInput) {
      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.findWithCursor("file", (b) => {
            const prefix = input.prefix ?? "";

            if (input.status && input.uploaderId) {
              const status = input.status;
              const uploaderId = input.uploaderId;
              const query = b.whereIndex("idx_file_provider_key_status_uploaderId", (eb) =>
                eb.and(
                  input.provider !== undefined
                    ? eb("provider", "=", input.provider)
                    : eb("provider", "starts with", ""),
                  eb("key", "starts with", prefix),
                  eb("status", "=", status),
                  eb("uploaderId", "=", uploaderId),
                ),
              );
              const ordered = query
                .orderByIndex("idx_file_provider_key_status_uploaderId", "asc")
                .pageSize(input.pageSize);
              return input.cursor ? ordered.after(input.cursor) : ordered;
            }

            if (input.status) {
              const status = input.status;
              const query = b.whereIndex("idx_file_provider_key_status", (eb) =>
                eb.and(
                  input.provider !== undefined
                    ? eb("provider", "=", input.provider)
                    : eb("provider", "starts with", ""),
                  eb("key", "starts with", prefix),
                  eb("status", "=", status),
                ),
              );
              const ordered = query
                .orderByIndex("idx_file_provider_key_status", "asc")
                .pageSize(input.pageSize);
              return input.cursor ? ordered.after(input.cursor) : ordered;
            }

            if (input.uploaderId) {
              const uploaderId = input.uploaderId;
              const query = b.whereIndex("idx_file_provider_key_uploaderId", (eb) =>
                eb.and(
                  input.provider !== undefined
                    ? eb("provider", "=", input.provider)
                    : eb("provider", "starts with", ""),
                  eb("key", "starts with", prefix),
                  eb("uploaderId", "=", uploaderId),
                ),
              );
              const ordered = query
                .orderByIndex("idx_file_provider_key_uploaderId", "asc")
                .pageSize(input.pageSize);
              return input.cursor ? ordered.after(input.cursor) : ordered;
            }

            const query = b.whereIndex("idx_file_provider_key", (eb) =>
              eb.and(
                input.provider !== undefined
                  ? eb("provider", "=", input.provider)
                  : eb("provider", "starts with", ""),
                eb("key", "starts with", prefix),
              ),
            );
            const ordered = query
              .orderByIndex("idx_file_provider_key", "asc")
              .pageSize(input.pageSize);
            return input.cursor ? ordered.after(input.cursor) : ordered;
          }),
        )
        .transformRetrieve(([result]) => result)
        .build();
    },

    updateFile: function (
      this: UploadServiceContext,
      fileByKey: FileByKeyInput,
      input: UpdateFileInput,
    ) {
      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.findFirst("file", (b) =>
            b.whereIndex("idx_file_provider_key", (eb) =>
              eb.and(eb("provider", "=", fileByKey.provider), eb("key", "=", fileByKey.fileKey)),
            ),
          ),
        )
        .mutate(({ uow, retrieveResult: [file] }) => {
          if (!file) {
            throw new UploadServiceError("FILE_NOT_FOUND", "The file does not exist.");
          }

          if (file.status === "deleted") {
            throw new UploadServiceError(
              "UPLOAD_INVALID_STATE",
              "Deleted file metadata cannot be updated.",
            );
          }

          const updatedFile = {
            key: file.key,
            provider: file.provider,
            uploaderId: file.uploaderId,
            filename: input.filename ?? file.filename,
            sizeBytes: file.sizeBytes,
            contentType: file.contentType,
            checksum: file.checksum,
            visibility: input.visibility ?? file.visibility,
            tags: input.tags ?? file.tags,
            metadata: input.metadata ?? file.metadata,
            status: file.status,
            errorCode: file.errorCode,
            errorMessage: file.errorMessage,
          };

          uow.update("file", file.id, (b) =>
            b
              .set({
                filename: updatedFile.filename,
                visibility: updatedFile.visibility,
                tags: updatedFile.tags,
                metadata: updatedFile.metadata,
                updatedAt: uow.now(),
              })
              .check(),
          );

          return updatedFile;
        })
        .build();
    },

    markFileDeleted: function (
      this: UploadServiceContext,
      fileByKey: FileByKeyInput,
      uploadId?: string,
    ) {
      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.findFirst("file", (b) =>
            b.whereIndex("idx_file_provider_key", (eb) =>
              eb.and(eb("provider", "=", fileByKey.provider), eb("key", "=", fileByKey.fileKey)),
            ),
          ),
        )
        .mutate(({ uow, retrieveResult: [file] }) => {
          if (!file) {
            throw new UploadServiceError("FILE_NOT_FOUND", "The file does not exist.");
          }

          if (file.status === "deleted") {
            return { status: "deleted" as FileStatus };
          }

          const databaseNow = uow.now();
          uow.update("file", file.id, (b) =>
            b
              .set({
                status: "deleted",
                updatedAt: databaseNow,
                deletedAt: databaseNow,
              })
              .check(),
          );

          uow.triggerHook("onFileDeleted", {
            ...buildFileHookPayload(file, uploadId),
          });

          return { status: "deleted" as FileStatus };
        })
        .build();
    },
  };
};
