import type { TableToColumnValues } from "@fragno-dev/db/query";
import type { DatabaseServiceContext } from "@fragno-dev/db";
import type {
  FileHookPayload,
  UploadFragmentResolvedConfig,
  UploadTimeoutPayload,
} from "../config";
import type { FileKeyEncoded, FileKeyParts } from "../keys";
import { uploadSchema } from "../schema";
import type { UploadChecksum } from "../storage/types";
import type { FileStatus, FileVisibility, UploadStatus, UploadStrategy } from "../types";
import { resolveFileKeyInput } from "./helpers";

export type CreateUploadInput = {
  keyParts?: FileKeyParts;
  fileKey?: FileKeyEncoded;
  filename: string;
  sizeBytes: number;
  contentType: string;
  checksum?: UploadChecksum | null;
  tags?: string[];
  visibility?: FileVisibility;
  uploaderId?: string;
  metadata?: Record<string, unknown>;
};

export type UploadProgressInput = {
  bytesUploaded?: number;
  partsUploaded?: number;
};

export type CompletePartsInput = {
  parts: { partNumber: number; etag: string; sizeBytes: number }[];
};

export type CreateUploadResult = {
  uploadId: string;
  fileKey: FileKeyEncoded;
  fileKeyParts: FileKeyParts;
  status: "created";
  strategy: UploadStrategy;
  expiresAt: Date;
  upload: {
    mode: "single" | "multipart";
    transport: "direct" | "proxy";
    uploadUrl?: string;
    uploadHeaders?: Record<string, string>;
    partSizeBytes?: number;
    maxParts?: number;
    partsEndpoint?: string;
    completeEndpoint: string;
    contentEndpoint?: string;
  };
};

type UploadRow = TableToColumnValues<typeof uploadSchema.tables.upload>;

const DEFAULT_VISIBILITY: FileVisibility = "private";

type UploadHooks = {
  onFileReady: (payload: FileHookPayload) => void | Promise<void>;
  onUploadFailed: (payload: FileHookPayload) => void | Promise<void>;
  onFileDeleted: (payload: FileHookPayload) => void | Promise<void>;
  onUploadTimeout: (payload: UploadTimeoutPayload) => void | Promise<void>;
};

type UploadServiceContext = DatabaseServiceContext<UploadHooks>;

const isTerminalUploadStatus = (status: UploadStatus) =>
  status === "completed" || status === "aborted" || status === "failed" || status === "expired";

const toBigInt = (value: number | bigint) => (typeof value === "bigint" ? value : BigInt(value));

const ensureActiveUpload = (upload: UploadRow, now: Date) => {
  if (upload.status === "expired") {
    throw new Error("UPLOAD_EXPIRED");
  }

  if (isTerminalUploadStatus(upload.status as UploadStatus)) {
    throw new Error("UPLOAD_INVALID_STATE");
  }

  if (upload.expiresAt.getTime() <= now.getTime()) {
    throw new Error("UPLOAD_EXPIRED");
  }
};

const ensureMultipartUpload = (upload: UploadRow) => {
  if (upload.strategy !== "direct-multipart") {
    throw new Error("UPLOAD_INVALID_STATE");
  }

  if (!upload.storageUploadId || !upload.partSizeBytes) {
    throw new Error("UPLOAD_INVALID_STATE");
  }
};

export const createUploadServices = (config: UploadFragmentResolvedConfig) => {
  const storage = config.storage;

  return {
    createUploadRecord: function (
      this: UploadServiceContext,
      input: CreateUploadInput & {
        storageInit: Awaited<ReturnType<typeof storage.initUpload>>;
      },
    ) {
      const resolved = resolveFileKeyInput(input);
      const now = new Date();

      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.findFirst("file", (b) =>
            b.whereIndex("idx_file_key", (eb) => eb("fileKey", "=", resolved.fileKey)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existingFile] }) => {
          if (existingFile) {
            throw new Error("INVALID_FILE_KEY");
          }

          const visibility = input.visibility ?? DEFAULT_VISIBILITY;
          const storageInit = input.storageInit;

          const fileId = uow.create("file", {
            fileKey: resolved.fileKey,
            uploaderId: input.uploaderId ?? null,
            filename: input.filename,
            sizeBytes: toBigInt(input.sizeBytes),
            contentType: input.contentType,
            checksum: input.checksum ?? null,
            visibility,
            tags: input.tags ?? null,
            metadata: input.metadata ?? null,
            status: "uploading",
            storageProvider: storage.name,
            storageKey: storageInit.storageKey,
            createdAt: now,
            updatedAt: now,
            completedAt: null,
            deletedAt: null,
            errorCode: null,
            errorMessage: null,
          });

          const uploadId = uow.create("upload", {
            fileKey: resolved.fileKey,
            status: "created",
            strategy: storageInit.strategy,
            storageUploadId: storageInit.storageUploadId ?? null,
            expectedSizeBytes: toBigInt(input.sizeBytes),
            bytesUploaded: 0n,
            partsUploaded: 0,
            partSizeBytes: storageInit.partSizeBytes ?? null,
            expiresAt: storageInit.expiresAt,
            createdAt: now,
            updatedAt: now,
            completedAt: null,
            errorCode: null,
            errorMessage: null,
          });

          uow.triggerHook(
            "onUploadTimeout",
            {
              uploadId: uploadId.toString(),
              fileKey: resolved.fileKey,
              fileKeyParts: resolved.fileKeyParts,
            },
            { processAt: storageInit.expiresAt },
          );

          return {
            fileId: fileId.toString(),
            uploadId: uploadId.toString(),
            resolved,
            storageInit,
          };
        })
        .transform(({ mutateResult }) => {
          const uploadId = mutateResult.uploadId;
          const strategy = mutateResult.storageInit.strategy;

          return {
            uploadId,
            fileKey: mutateResult.resolved.fileKey,
            fileKeyParts: mutateResult.resolved.fileKeyParts,
            status: "created",
            strategy,
            expiresAt: mutateResult.storageInit.expiresAt,
            upload: {
              mode: strategy === "direct-multipart" ? "multipart" : "single",
              transport: strategy === "proxy" ? "proxy" : "direct",
              uploadUrl: mutateResult.storageInit.uploadUrl,
              uploadHeaders: mutateResult.storageInit.uploadHeaders,
              partSizeBytes: mutateResult.storageInit.partSizeBytes,
              maxParts: storage.limits?.maxMultipartParts,
              partsEndpoint:
                strategy === "direct-multipart" ? `/uploads/${uploadId}/parts` : undefined,
              completeEndpoint: `/uploads/${uploadId}/complete`,
              contentEndpoint: strategy === "proxy" ? `/uploads/${uploadId}/content` : undefined,
            },
          } satisfies CreateUploadResult;
        })
        .build();
    },

    getUploadStatus: function (this: UploadServiceContext, uploadId: string) {
      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.findFirst("upload", (b) => b.whereIndex("primary", (eb) => eb("id", "=", uploadId))),
        )
        .transformRetrieve(([upload]) => {
          if (!upload) {
            throw new Error("UPLOAD_NOT_FOUND");
          }
          return upload;
        })
        .build();
    },

    getUploadParts: function (this: UploadServiceContext, uploadId: string) {
      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.find("upload_part", (b) =>
            b.whereIndex("idx_upload_part_upload", (eb) => eb("uploadId", "=", uploadId)),
          ),
        )
        .transformRetrieve(([parts]) => parts)
        .build();
    },

    recordUploadProgress: function (
      this: UploadServiceContext,
      uploadId: string,
      input: UploadProgressInput,
    ) {
      const now = new Date();

      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.findFirst("upload", (b) => b.whereIndex("primary", (eb) => eb("id", "=", uploadId))),
        )
        .mutate(({ uow, retrieveResult: [upload] }) => {
          if (!upload) {
            throw new Error("UPLOAD_NOT_FOUND");
          }

          ensureActiveUpload(upload, now);

          const nextBytes =
            input.bytesUploaded !== undefined
              ? (() => {
                  const inputBigInt = BigInt(input.bytesUploaded);
                  return upload.bytesUploaded > inputBigInt ? upload.bytesUploaded : inputBigInt;
                })()
              : upload.bytesUploaded;
          const nextParts =
            input.partsUploaded !== undefined
              ? Math.max(upload.partsUploaded, input.partsUploaded)
              : upload.partsUploaded;

          uow.update("upload", upload.id, (b) =>
            b
              .set({
                bytesUploaded: nextBytes,
                partsUploaded: nextParts,
                status: "in_progress",
                updatedAt: now,
              })
              .check(),
          );

          return { bytesUploaded: nextBytes, partsUploaded: nextParts };
        })
        .build();
    },

    recordUploadParts: function (
      this: UploadServiceContext,
      uploadId: string,
      input: CompletePartsInput,
    ) {
      const now = new Date();

      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow
            .findFirst("upload", (b) => b.whereIndex("primary", (eb) => eb("id", "=", uploadId)))
            .find("upload_part", (b) =>
              b.whereIndex("idx_upload_part_upload", (eb) => eb("uploadId", "=", uploadId)),
            ),
        )
        .mutate(({ uow, retrieveResult: [upload, parts] }) => {
          if (!upload) {
            throw new Error("UPLOAD_NOT_FOUND");
          }

          ensureActiveUpload(upload, now);
          ensureMultipartUpload(upload);

          const existing = new Set(parts.map((part) => part.partNumber));
          const existingBytes = parts.reduce((sum, part) => sum + toBigInt(part.sizeBytes), 0n);
          let addedParts = 0;
          let addedBytes = 0n;

          for (const part of input.parts) {
            if (existing.has(part.partNumber)) {
              continue;
            }
            existing.add(part.partNumber);
            addedParts += 1;
            addedBytes += toBigInt(part.sizeBytes);

            uow.create("upload_part", {
              uploadId: upload.id,
              partNumber: part.partNumber,
              etag: part.etag,
              sizeBytes: toBigInt(part.sizeBytes),
              createdAt: now,
            });
          }

          const totalParts = existing.size;
          const totalBytes = existingBytes + addedBytes;
          const nextParts = Math.max(upload.partsUploaded, totalParts);
          const nextBytes = upload.bytesUploaded > totalBytes ? upload.bytesUploaded : totalBytes;

          if (addedParts > 0) {
            uow.update("upload", upload.id, (b) =>
              b
                .set({
                  partsUploaded: nextParts,
                  bytesUploaded: nextBytes,
                  status: "in_progress",
                  updatedAt: now,
                })
                .check(),
            );
          }

          return {
            partsUploaded: nextParts,
            bytesUploaded: nextBytes,
          };
        })
        .build();
    },

    markUploadComplete: function (
      this: UploadServiceContext,
      uploadId: string,
      fileKey: FileKeyEncoded,
      options?: { sizeBytes?: bigint },
    ) {
      const now = new Date();

      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow
            .findFirst("upload", (b) => b.whereIndex("primary", (eb) => eb("id", "=", uploadId)))
            .findFirst("file", (b) =>
              b.whereIndex("idx_file_key", (eb) => eb("fileKey", "=", fileKey)),
            ),
        )
        .mutate(({ uow, retrieveResult: [upload, file] }) => {
          if (!upload) {
            throw new Error("UPLOAD_NOT_FOUND");
          }

          ensureActiveUpload(upload, now);

          const updatedUpload = {
            ...upload,
            status: "completed" as UploadStatus,
            updatedAt: now,
            completedAt: now,
            bytesUploaded: options?.sizeBytes ?? upload.bytesUploaded,
          };

          uow.update("upload", upload.id, (b) =>
            b
              .set({
                status: updatedUpload.status,
                updatedAt: updatedUpload.updatedAt,
                completedAt: updatedUpload.completedAt,
                bytesUploaded: updatedUpload.bytesUploaded,
              })
              .check(),
          );

          if (!file) {
            throw new Error("FILE_NOT_FOUND");
          }

          const updatedFile = {
            ...file,
            status: "ready" as FileStatus,
            updatedAt: now,
            completedAt: now,
            sizeBytes: options?.sizeBytes ?? file.sizeBytes,
            errorCode: null,
            errorMessage: null,
          };

          uow.update("file", file.id, (b) =>
            b
              .set({
                status: updatedFile.status,
                updatedAt: updatedFile.updatedAt,
                completedAt: updatedFile.completedAt,
                sizeBytes: updatedFile.sizeBytes,
                errorCode: updatedFile.errorCode,
                errorMessage: updatedFile.errorMessage,
              })
              .check(),
          );

          uow.triggerHook("onFileReady", {
            fileKey: file.fileKey,
            fileKeyParts: resolveFileKeyInput({ fileKey: file.fileKey }).fileKeyParts,
            uploadId: upload.id.toString(),
            uploaderId: file.uploaderId,
            sizeBytes: Number(options?.sizeBytes ?? file.sizeBytes),
            contentType: file.contentType,
          });

          return { upload: updatedUpload, file: updatedFile };
        })
        .build();
    },

    markUploadFailed: function (
      this: UploadServiceContext,
      uploadId: string,
      fileKey: FileKeyEncoded,
      errorCode: string,
      errorMessage?: string | null,
    ) {
      const now = new Date();

      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow
            .findFirst("upload", (b) => b.whereIndex("primary", (eb) => eb("id", "=", uploadId)))
            .findFirst("file", (b) =>
              b.whereIndex("idx_file_key", (eb) => eb("fileKey", "=", fileKey)),
            ),
        )
        .mutate(({ uow, retrieveResult: [upload, file] }) => {
          if (!upload) {
            throw new Error("UPLOAD_NOT_FOUND");
          }

          if (upload.status === "completed") {
            throw new Error("UPLOAD_INVALID_STATE");
          }

          const updatedUpload = {
            ...upload,
            status: "failed" as UploadStatus,
            updatedAt: now,
            errorCode,
            errorMessage: errorMessage ?? null,
          };

          uow.update("upload", upload.id, (b) =>
            b
              .set({
                status: updatedUpload.status,
                updatedAt: updatedUpload.updatedAt,
                errorCode: updatedUpload.errorCode,
                errorMessage: updatedUpload.errorMessage,
              })
              .check(),
          );

          if (!file) {
            throw new Error("FILE_NOT_FOUND");
          }

          const updatedFile = {
            ...file,
            status: "failed" as FileStatus,
            updatedAt: now,
            errorCode,
            errorMessage: errorMessage ?? null,
          };

          uow.update("file", file.id, (b) =>
            b
              .set({
                status: updatedFile.status,
                updatedAt: updatedFile.updatedAt,
                errorCode: updatedFile.errorCode,
                errorMessage: updatedFile.errorMessage,
              })
              .check(),
          );

          uow.triggerHook("onUploadFailed", {
            fileKey: file.fileKey,
            fileKeyParts: resolveFileKeyInput({ fileKey: file.fileKey }).fileKeyParts,
            uploadId: upload.id.toString(),
            uploaderId: file.uploaderId,
            sizeBytes: Number(file.sizeBytes),
            contentType: file.contentType,
          });

          return { upload: updatedUpload, file: updatedFile };
        })
        .build();
    },

    markUploadAborted: function (
      this: UploadServiceContext,
      uploadId: string,
      fileKey: FileKeyEncoded,
    ) {
      const now = new Date();

      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow
            .findFirst("upload", (b) => b.whereIndex("primary", (eb) => eb("id", "=", uploadId)))
            .findFirst("file", (b) =>
              b.whereIndex("idx_file_key", (eb) => eb("fileKey", "=", fileKey)),
            ),
        )
        .mutate(({ uow, retrieveResult: [upload, file] }) => {
          if (!upload) {
            throw new Error("UPLOAD_NOT_FOUND");
          }

          if (upload.status === "completed") {
            throw new Error("UPLOAD_INVALID_STATE");
          }

          const updatedUpload = {
            ...upload,
            status: "aborted" as UploadStatus,
            updatedAt: now,
            errorCode: "UPLOAD_ABORTED",
          };

          uow.update("upload", upload.id, (b) =>
            b
              .set({
                status: updatedUpload.status,
                updatedAt: updatedUpload.updatedAt,
                errorCode: updatedUpload.errorCode,
              })
              .check(),
          );

          if (!file) {
            throw new Error("FILE_NOT_FOUND");
          }

          const updatedFile = {
            ...file,
            status: "failed" as FileStatus,
            updatedAt: now,
            errorCode: "UPLOAD_ABORTED",
          };

          uow.update("file", file.id, (b) =>
            b
              .set({
                status: updatedFile.status,
                updatedAt: updatedFile.updatedAt,
                errorCode: updatedFile.errorCode,
              })
              .check(),
          );

          uow.triggerHook("onUploadFailed", {
            fileKey: file.fileKey,
            fileKeyParts: resolveFileKeyInput({ fileKey: file.fileKey }).fileKeyParts,
            uploadId: upload.id.toString(),
            uploaderId: file.uploaderId,
            sizeBytes: Number(file.sizeBytes),
            contentType: file.contentType,
          });

          return { upload: updatedUpload, file: updatedFile };
        })
        .build();
    },

    getUploadStorageInfo: function (this: UploadServiceContext, uploadId: string) {
      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.findFirst("upload", (b) => b.whereIndex("primary", (eb) => eb("id", "=", uploadId))),
        )
        .transformRetrieve(([upload]) => {
          if (!upload) {
            throw new Error("UPLOAD_NOT_FOUND");
          }
          return upload;
        })
        .build();
    },
  };
};
