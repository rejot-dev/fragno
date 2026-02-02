import type { DatabaseServiceContext } from "@fragno-dev/db";
import type {
  FileHookPayload,
  UploadFragmentResolvedConfig,
  UploadTimeoutPayload,
} from "../config";
import type { FileKeyEncoded, FileKeyParts } from "../keys";
import { uploadSchema } from "../schema";
import type { FileStatus } from "../types";

export type ListFilesInput = {
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

type UploadHooks = {
  onFileReady: (payload: FileHookPayload) => void | Promise<void>;
  onUploadFailed: (payload: FileHookPayload) => void | Promise<void>;
  onFileDeleted: (payload: FileHookPayload) => void | Promise<void>;
  onUploadTimeout: (payload: UploadTimeoutPayload) => void | Promise<void>;
};

type UploadServiceContext = DatabaseServiceContext<UploadHooks>;

export const createFileServices = (_config: UploadFragmentResolvedConfig) => {
  return {
    getFileByKey: function (this: UploadServiceContext, fileKey: FileKeyEncoded) {
      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.findFirst("file", (b) =>
            b.whereIndex("idx_file_key", (eb) => eb("fileKey", "=", fileKey)),
          ),
        )
        .transformRetrieve(([file]) => {
          if (!file) {
            throw new Error("FILE_NOT_FOUND");
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
              const query = b.whereIndex("idx_file_key_status_uploaderId", (eb) =>
                eb.and(
                  eb("fileKey", "starts with", prefix),
                  eb("status", "=", status),
                  eb("uploaderId", "=", uploaderId),
                ),
              );
              const ordered = query
                .orderByIndex("idx_file_key_status_uploaderId", "asc")
                .pageSize(input.pageSize);
              return input.cursor ? ordered.after(input.cursor) : ordered;
            }

            if (input.status) {
              const status = input.status;
              const query = b.whereIndex("idx_file_key_status", (eb) =>
                eb.and(eb("fileKey", "starts with", prefix), eb("status", "=", status)),
              );
              const ordered = query
                .orderByIndex("idx_file_key_status", "asc")
                .pageSize(input.pageSize);
              return input.cursor ? ordered.after(input.cursor) : ordered;
            }

            if (input.uploaderId) {
              const uploaderId = input.uploaderId;
              const query = b.whereIndex("idx_file_key_uploaderId", (eb) =>
                eb.and(eb("fileKey", "starts with", prefix), eb("uploaderId", "=", uploaderId)),
              );
              const ordered = query
                .orderByIndex("idx_file_key_uploaderId", "asc")
                .pageSize(input.pageSize);
              return input.cursor ? ordered.after(input.cursor) : ordered;
            }

            const query = b.whereIndex("idx_file_key", (eb) =>
              eb("fileKey", "starts with", prefix),
            );
            const ordered = query.orderByIndex("idx_file_key", "asc").pageSize(input.pageSize);
            return input.cursor ? ordered.after(input.cursor) : ordered;
          }),
        )
        .transformRetrieve(([result]) => result)
        .build();
    },

    updateFile: function (
      this: UploadServiceContext,
      fileKey: FileKeyEncoded,
      input: UpdateFileInput,
    ) {
      const now = new Date();
      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.findFirst("file", (b) =>
            b.whereIndex("idx_file_key", (eb) => eb("fileKey", "=", fileKey)),
          ),
        )
        .mutate(({ uow, retrieveResult: [file] }) => {
          if (!file) {
            throw new Error("FILE_NOT_FOUND");
          }

          if (file.status === "deleted") {
            throw new Error("UPLOAD_INVALID_STATE");
          }

          const updatedFile = {
            ...file,
            filename: input.filename ?? file.filename,
            visibility: (input.visibility ?? file.visibility) as string,
            tags: input.tags ?? file.tags,
            metadata: input.metadata ?? file.metadata,
            updatedAt: now,
          };

          uow.update("file", file.id, (b) =>
            b
              .set({
                filename: updatedFile.filename,
                visibility: updatedFile.visibility,
                tags: updatedFile.tags,
                metadata: updatedFile.metadata,
                updatedAt: updatedFile.updatedAt,
              })
              .check(),
          );

          return updatedFile;
        })
        .build();
    },

    markFileDeleted: function (
      this: UploadServiceContext,
      fileKey: FileKeyEncoded,
      fileKeyParts: FileKeyParts,
      uploadId?: string,
    ) {
      const now = new Date();
      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.findFirst("file", (b) =>
            b.whereIndex("idx_file_key", (eb) => eb("fileKey", "=", fileKey)),
          ),
        )
        .mutate(({ uow, retrieveResult: [file] }) => {
          if (!file) {
            throw new Error("FILE_NOT_FOUND");
          }

          if (file.status === "deleted") {
            return file;
          }

          const updatedFile = {
            ...file,
            status: "deleted" as FileStatus,
            updatedAt: now,
            deletedAt: now,
          };

          uow.update("file", file.id, (b) =>
            b
              .set({
                status: updatedFile.status,
                updatedAt: updatedFile.updatedAt,
                deletedAt: updatedFile.deletedAt,
              })
              .check(),
          );

          uow.triggerHook("onFileDeleted", {
            fileKey: file.fileKey,
            fileKeyParts,
            uploadId,
            uploaderId: file.uploaderId,
            sizeBytes: Number(file.sizeBytes),
            contentType: file.contentType,
          });

          return updatedFile;
        })
        .build();
    },
  };
};
