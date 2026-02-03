import { isDeepStrictEqual } from "node:util";
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
  status: "created" | "in_progress";
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
const MAX_SAFE_SIZE_BYTES = BigInt(Number.MAX_SAFE_INTEGER);
const toSafeNumber = (value: bigint) => {
  if (value > MAX_SAFE_SIZE_BYTES) {
    throw new Error("INVALID_REQUEST");
  }
  return Number(value);
};

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

type NormalizedUploadInput = {
  keyParts?: FileKeyParts;
  fileKey?: FileKeyEncoded;
  filename: string;
  sizeBytes: number;
  contentType: string;
  checksum: UploadChecksum | null;
  tags: string[] | null;
  visibility: FileVisibility;
  uploaderId: string | null;
  metadata: Record<string, unknown> | null;
  expectedSizeBytes: bigint;
};

const normalizeUploadInput = (input: CreateUploadInput): NormalizedUploadInput => {
  return {
    ...input,
    uploaderId: input.uploaderId ?? null,
    visibility: input.visibility ?? DEFAULT_VISIBILITY,
    checksum: input.checksum ?? null,
    tags: input.tags ?? null,
    metadata: input.metadata ?? null,
    expectedSizeBytes: toBigInt(input.sizeBytes),
  };
};

const pickActiveUpload = (uploads: UploadRow[], now: Date) => {
  const active = uploads.filter(
    (upload) =>
      !isTerminalUploadStatus(upload.status as UploadStatus) &&
      upload.expiresAt.getTime() > now.getTime(),
  );
  if (active.length === 0) {
    return null;
  }
  return active.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
};

const uploadMetadataMatches = (upload: UploadRow, input: NormalizedUploadInput) => {
  return (
    upload.filename === input.filename &&
    upload.contentType === input.contentType &&
    upload.visibility === input.visibility &&
    (upload.uploaderId ?? null) === input.uploaderId &&
    upload.expectedSizeBytes === input.expectedSizeBytes &&
    isDeepStrictEqual(upload.checksum ?? null, input.checksum) &&
    isDeepStrictEqual(upload.tags ?? null, input.tags) &&
    isDeepStrictEqual(upload.metadata ?? null, input.metadata)
  );
};

const buildCreateUploadResult = (
  storage: UploadFragmentResolvedConfig["storage"],
  upload: UploadRow,
): CreateUploadResult => {
  const uploadId = upload.id.toString();
  const strategy = upload.strategy as UploadStrategy;
  const resolved = resolveFileKeyInput({ fileKey: upload.fileKey });
  const uploadHeaders = upload.uploadHeaders as Record<string, string> | null;

  return {
    uploadId,
    fileKey: upload.fileKey,
    fileKeyParts: resolved.fileKeyParts,
    status: upload.status as CreateUploadResult["status"],
    strategy,
    expiresAt: upload.expiresAt,
    upload: {
      mode: strategy === "direct-multipart" ? "multipart" : "single",
      transport: strategy === "proxy" ? "proxy" : "direct",
      uploadUrl: upload.uploadUrl ?? undefined,
      uploadHeaders: uploadHeaders ?? undefined,
      partSizeBytes: upload.partSizeBytes ?? undefined,
      maxParts: storage.limits?.maxMultipartParts,
      partsEndpoint: strategy === "direct-multipart" ? `/uploads/${uploadId}/parts` : undefined,
      completeEndpoint: `/uploads/${uploadId}/complete`,
      contentEndpoint: strategy === "proxy" ? `/uploads/${uploadId}/content` : undefined,
    },
  };
};

const buildCreateUploadResultFromInit = (
  storage: UploadFragmentResolvedConfig["storage"],
  resolved: ReturnType<typeof resolveFileKeyInput>,
  storageInit: Awaited<ReturnType<UploadFragmentResolvedConfig["storage"]["initUpload"]>>,
  uploadId: string,
): CreateUploadResult => {
  const strategy = storageInit.strategy;

  return {
    uploadId,
    fileKey: resolved.fileKey,
    fileKeyParts: resolved.fileKeyParts,
    status: "created",
    strategy,
    expiresAt: storageInit.expiresAt,
    upload: {
      mode: strategy === "direct-multipart" ? "multipart" : "single",
      transport: strategy === "proxy" ? "proxy" : "direct",
      uploadUrl: storageInit.uploadUrl,
      uploadHeaders: storageInit.uploadHeaders,
      partSizeBytes: storageInit.partSizeBytes,
      maxParts: storage.limits?.maxMultipartParts,
      partsEndpoint: strategy === "direct-multipart" ? `/uploads/${uploadId}/parts` : undefined,
      completeEndpoint: `/uploads/${uploadId}/complete`,
      contentEndpoint: strategy === "proxy" ? `/uploads/${uploadId}/content` : undefined,
    },
  };
};

const buildUploadHookPayload = (upload: UploadRow, sizeBytes?: bigint): FileHookPayload => {
  const fileKeyParts = resolveFileKeyInput({ fileKey: upload.fileKey }).fileKeyParts;
  const resolvedSizeBytes = sizeBytes ?? upload.expectedSizeBytes;
  return {
    fileKey: upload.fileKey,
    fileKeyParts,
    uploadId: upload.id.toString(),
    uploaderId: upload.uploaderId ?? null,
    sizeBytes: toSafeNumber(resolvedSizeBytes),
    contentType: upload.contentType,
  };
};

export const createUploadServices = (config: UploadFragmentResolvedConfig) => {
  const storage = config.storage;

  return {
    checkUploadAvailability: function (
      this: UploadServiceContext,
      input: CreateUploadInput,
      options: { allowIdempotentReuse: boolean },
    ) {
      const resolved = resolveFileKeyInput(input);
      const now = new Date();
      const normalized = normalizeUploadInput(input);
      const hasChecksum = normalized.checksum !== null;

      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow
            .findFirst("file", (b) =>
              b.whereIndex("idx_file_key", (eb) => eb("fileKey", "=", resolved.fileKey)),
            )
            .find("upload", (b) =>
              b.whereIndex("idx_upload_file_key", (eb) => eb("fileKey", "=", resolved.fileKey)),
            ),
        )
        .transformRetrieve(([file, uploads]) => {
          if (file) {
            throw new Error("FILE_ALREADY_EXISTS");
          }

          const activeUpload = pickActiveUpload(uploads as UploadRow[], now);
          if (!activeUpload) {
            return null;
          }

          if (!options.allowIdempotentReuse || !hasChecksum) {
            throw new Error("UPLOAD_ALREADY_ACTIVE");
          }

          if (!uploadMetadataMatches(activeUpload, normalized)) {
            throw new Error("UPLOAD_METADATA_MISMATCH");
          }

          return buildCreateUploadResult(storage, activeUpload);
        })
        .build();
    },

    createUploadRecord: function (
      this: UploadServiceContext,
      input: CreateUploadInput & {
        storageInit: Awaited<ReturnType<typeof storage.initUpload>>;
        allowIdempotentReuse: boolean;
      },
    ) {
      const resolved = resolveFileKeyInput(input);
      const now = new Date();
      const normalized = normalizeUploadInput(input);
      const hasChecksum = normalized.checksum !== null;

      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow
            .findFirst("file", (b) =>
              b.whereIndex("idx_file_key", (eb) => eb("fileKey", "=", resolved.fileKey)),
            )
            .find("upload", (b) =>
              b.whereIndex("idx_upload_file_key", (eb) => eb("fileKey", "=", resolved.fileKey)),
            ),
        )
        .mutate(({ uow, retrieveResult: [existingFile, uploads] }) => {
          if (existingFile) {
            throw new Error("FILE_ALREADY_EXISTS");
          }

          const activeUpload = pickActiveUpload(uploads as UploadRow[], now);
          if (activeUpload) {
            if (!input.allowIdempotentReuse || !hasChecksum) {
              throw new Error("UPLOAD_ALREADY_ACTIVE");
            }

            if (!uploadMetadataMatches(activeUpload, normalized)) {
              throw new Error("UPLOAD_METADATA_MISMATCH");
            }

            return {
              reused: true as const,
              existingUpload: activeUpload,
            };
          }

          const storageInit = input.storageInit;

          const uploadId = uow.create("upload", {
            fileKey: resolved.fileKey,
            uploaderId: normalized.uploaderId,
            filename: normalized.filename,
            expectedSizeBytes: normalized.expectedSizeBytes,
            contentType: normalized.contentType,
            checksum: normalized.checksum,
            visibility: normalized.visibility,
            tags: normalized.tags,
            metadata: normalized.metadata,
            status: "created",
            strategy: storageInit.strategy,
            storageProvider: storage.name,
            storageKey: storageInit.storageKey,
            storageUploadId: storageInit.storageUploadId ?? null,
            uploadUrl: storageInit.uploadUrl ?? null,
            uploadHeaders: storageInit.uploadHeaders ?? null,
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
            reused: false as const,
            uploadId: uploadId.toString(),
            resolved,
            storageInit,
          };
        })
        .transform(({ mutateResult }) => {
          if (mutateResult.reused) {
            return {
              reused: true as const,
              result: buildCreateUploadResult(storage, mutateResult.existingUpload),
            };
          }

          return {
            reused: false as const,
            result: buildCreateUploadResultFromInit(
              storage,
              mutateResult.resolved,
              mutateResult.storageInit,
              mutateResult.uploadId,
            ),
          };
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
        .mutate(({ uow, retrieveResult: [upload, existingFile] }) => {
          if (!upload) {
            throw new Error("UPLOAD_NOT_FOUND");
          }

          ensureActiveUpload(upload, now);

          if (existingFile) {
            throw new Error("FILE_ALREADY_EXISTS");
          }

          const finalSizeBytes = options?.sizeBytes ?? upload.expectedSizeBytes;

          const updatedUpload = {
            ...upload,
            status: "completed" as UploadStatus,
            updatedAt: now,
            completedAt: now,
            bytesUploaded: finalSizeBytes,
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

          const createdFile = {
            fileKey: upload.fileKey,
            uploaderId: upload.uploaderId ?? null,
            filename: upload.filename,
            sizeBytes: finalSizeBytes,
            contentType: upload.contentType,
            checksum: upload.checksum ?? null,
            visibility: upload.visibility,
            tags: upload.tags ?? null,
            metadata: upload.metadata ?? null,
            status: "ready" as FileStatus,
            storageProvider: upload.storageProvider,
            storageKey: upload.storageKey,
            createdAt: now,
            updatedAt: now,
            completedAt: now,
            deletedAt: null,
            errorCode: null,
            errorMessage: null,
          };

          const fileId = uow.create("file", createdFile);

          uow.triggerHook("onFileReady", buildUploadHookPayload(upload, finalSizeBytes));

          return {
            upload: updatedUpload,
            file: {
              id: fileId,
              ...createdFile,
            },
          };
        })
        .build();
    },

    markUploadFailed: function (
      this: UploadServiceContext,
      uploadId: string,
      errorCode: string,
      errorMessage?: string | null,
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

          if (isTerminalUploadStatus(upload.status as UploadStatus)) {
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

          uow.triggerHook("onUploadFailed", buildUploadHookPayload(upload));

          return { upload: updatedUpload };
        })
        .build();
    },

    markUploadAborted: function (this: UploadServiceContext, uploadId: string) {
      const now = new Date();

      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.findFirst("upload", (b) => b.whereIndex("primary", (eb) => eb("id", "=", uploadId))),
        )
        .mutate(({ uow, retrieveResult: [upload] }) => {
          if (!upload) {
            throw new Error("UPLOAD_NOT_FOUND");
          }

          if (isTerminalUploadStatus(upload.status as UploadStatus)) {
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

          uow.triggerHook("onUploadFailed", buildUploadHookPayload(upload));

          return { upload: updatedUpload };
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
