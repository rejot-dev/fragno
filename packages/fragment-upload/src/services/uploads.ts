import type { TableToInsertValues } from "@fragno-dev/db/query";

import type { DatabaseServiceContext, TypedUnitOfWork } from "@fragno-dev/db";

import type { FileHookPayload, UploadTimeoutPayload } from "../config";
import { uploadSchema } from "../schema";
import type { PreparedFileBatchEntry, UploadFileWritePrecondition } from "../types";
import { UploadServiceError } from "./errors";
import {
  assertFileWritePrecondition,
  buildFileHookPayload,
  buildUploadHookPayload,
  type FileRow,
  planFilePublication,
  toPreparedFileWrite,
} from "./file-publication";
import { resolveFileKeyInput } from "./helpers";
import {
  type CompletePartsInput,
  type CreateUploadInput,
  ensureActiveUpload,
  ensureMultipartUpload,
  type InitializedUpload,
  isTerminalUploadStatus,
  normalizeUploadInput,
  pickActiveUpload,
  toBigInt,
  type UploadProgressInput,
  type UploadSessionSnapshot,
  type UploadSnapshot,
  toUploadSnapshot,
  uploadMetadataMatches,
} from "./upload-model";

export const MAX_PREPARED_FILE_BATCH_ENTRIES = 5_000;
const BATCH_QUERY_CHUNK_SIZE = 200;

type UploadWithFile = UploadSnapshot & { file: FileRow | null };
type UploadInsert = TableToInsertValues<typeof uploadSchema.tables.upload>;

export type StagedPreparedFileUpload = CreateUploadInput & {
  storageInit: InitializedUpload;
  completedSizeBytes: bigint;
};

type UploadHooks = {
  onFileReady: (payload: FileHookPayload) => void | Promise<void>;
  onFileTextIndexRequested: (payload: FileHookPayload) => void | Promise<void>;
  onUploadFailed: (payload: FileHookPayload) => void | Promise<void>;
  onFileDeleted: (payload: FileHookPayload) => void | Promise<void>;
  cleanupStorageObject: (payload: FileHookPayload) => void | Promise<void>;
  onUploadTimeout: (payload: UploadTimeoutPayload) => void | Promise<void>;
};

type UploadServiceContext = DatabaseServiceContext<UploadHooks>;
type UploadMutationUnitOfWork = TypedUnitOfWork<
  typeof uploadSchema,
  unknown[],
  unknown,
  UploadHooks
>;

const batchFileAddress = (provider: string, fileKey: string) => `${provider}\0${fileKey}`;

const chunkBatchValues = <T>(values: T[]): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += BATCH_QUERY_CHUNK_SIZE) {
    chunks.push(values.slice(index, index + BATCH_QUERY_CHUNK_SIZE));
  }
  return chunks;
};

export const createUploadServices = () => {
  return {
    createUploadRecord: function (
      this: UploadServiceContext,
      input: CreateUploadInput & {
        storageInit: InitializedUpload;
        allowIdempotentReuse: boolean;
      },
    ) {
      const resolved = resolveFileKeyInput(input);
      const normalized = normalizeUploadInput(input);
      const hasChecksum = normalized.checksum !== null;

      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.find("upload", (b) =>
            b.whereIndex("idx_upload_provider_key_status_expiresAt", (eb) =>
              eb.and(
                eb("provider", "=", normalized.provider),
                eb("key", "=", resolved.fileKey),
                eb("status", "in", ["created", "in_progress"]),
                eb("expiresAt", ">", eb.now()),
              ),
            ),
          ),
        )
        .mutate(({ uow, retrieveResult: [uploadRows] }) => {
          const activeUpload = pickActiveUpload(uploadRows.map(toUploadSnapshot));
          if (activeUpload) {
            if (
              input.allowIdempotentReuse &&
              hasChecksum &&
              uploadMetadataMatches(activeUpload, normalized)
            ) {
              return { reused: true as const, upload: activeUpload };
            }

            throw new UploadServiceError(
              "UPLOAD_ALREADY_ACTIVE",
              "An active upload already exists for this provider and file key.",
            );
          }

          const storageInit = input.storageInit;
          const databaseNow = uow.now();
          const uploadRecord: UploadInsert = {
            key: resolved.fileKey,
            provider: normalized.provider,
            uploaderId: normalized.uploaderId,
            filename: normalized.filename,
            expectedSizeBytes: normalized.expectedSizeBytes,
            contentType: normalized.contentType,
            checksum: normalized.checksum,
            visibility: normalized.visibility,
            tags: normalized.tags,
            metadata: normalized.metadata,
            status: "created",
            publicationMode: normalized.publicationMode,
            strategy: storageInit.strategy,
            objectKey: storageInit.storageKey,
            storageUploadId: storageInit.storageUploadId ?? null,
            uploadUrl: storageInit.uploadUrl ?? null,
            uploadHeaders: storageInit.uploadHeaders ?? null,
            bytesUploaded: 0n,
            partsUploaded: 0,
            partSizeBytes: storageInit.partSizeBytes ?? null,
            expiresAt: storageInit.expiresAt,
            createdAt: databaseNow,
            updatedAt: databaseNow,
            completedAt: null,
            errorCode: null,
            errorMessage: null,
          };
          const uploadId = uow.create("upload", uploadRecord);

          uow.triggerHook(
            "onUploadTimeout",
            {
              uploadId: uploadId.toString(),
              provider: normalized.provider,
              fileKey: resolved.fileKey,
            },
            { processAt: storageInit.expiresAt },
          );

          const upload: UploadSessionSnapshot = {
            id: uploadId,
            key: resolved.fileKey,
            provider: normalized.provider,
            status: "created",
            strategy: storageInit.strategy,
            publicationMode: normalized.publicationMode,
            expiresAt: storageInit.expiresAt,
            uploadUrl: storageInit.uploadUrl ?? null,
            uploadHeaders: storageInit.uploadHeaders ?? null,
            partSizeBytes: storageInit.partSizeBytes ?? null,
          };

          return { reused: false as const, upload };
        })
        .build();
    },

    createPreparedFileUploads: function (
      this: UploadServiceContext,
      inputs: StagedPreparedFileUpload[],
    ) {
      if (inputs.length === 0 || inputs.length > MAX_PREPARED_FILE_BATCH_ENTRIES) {
        throw new UploadServiceError(
          "INVALID_REQUEST",
          `Prepared upload batches must contain between 1 and ${MAX_PREPARED_FILE_BATCH_ENTRIES} files.`,
        );
      }

      const prepared = inputs.map((input) => ({
        resolved: resolveFileKeyInput(input),
        normalized: normalizeUploadInput({ ...input, publicationMode: "batch" }),
        storageInit: input.storageInit,
        completedSizeBytes: input.completedSizeBytes,
      }));

      return this.serviceTx(uploadSchema)
        .mutate(({ uow }) => {
          const databaseNow = uow.now();
          return prepared.map(({ resolved, normalized, storageInit, completedSizeBytes }) => {
            const uploadId = uow.create("upload", {
              key: resolved.fileKey,
              provider: normalized.provider,
              uploaderId: normalized.uploaderId,
              filename: normalized.filename,
              expectedSizeBytes: normalized.expectedSizeBytes,
              contentType: normalized.contentType,
              checksum: normalized.checksum,
              visibility: normalized.visibility,
              tags: normalized.tags,
              metadata: normalized.metadata,
              status: "prepared",
              publicationMode: "batch",
              strategy: storageInit.strategy,
              objectKey: storageInit.storageKey,
              storageUploadId: storageInit.storageUploadId ?? null,
              uploadUrl: storageInit.uploadUrl ?? null,
              uploadHeaders: storageInit.uploadHeaders ?? null,
              bytesUploaded: completedSizeBytes,
              partsUploaded: 0,
              partSizeBytes: storageInit.partSizeBytes ?? null,
              expiresAt: storageInit.expiresAt,
              createdAt: databaseNow,
              updatedAt: databaseNow,
              completedAt: databaseNow,
              errorCode: null,
              errorMessage: null,
            });

            uow.triggerHook(
              "onUploadTimeout",
              {
                uploadId: uploadId.toString(),
                provider: normalized.provider,
                fileKey: resolved.fileKey,
              },
              { processAt: storageInit.expiresAt },
            );

            return {
              uploadId: uploadId.toString(),
              provider: normalized.provider,
              fileKey: resolved.fileKey,
              objectKey: storageInit.storageKey,
              sizeBytes: Number(completedSizeBytes),
              contentType: normalized.contentType,
              checksum: normalized.checksum,
              expiresAt: storageInit.expiresAt.toISOString(),
            };
          });
        })
        .build();
    },

    createCompletedUpload: function (
      this: UploadServiceContext,
      input: CreateUploadInput & {
        storageInit: InitializedUpload;
        completedSizeBytes: bigint;
        precondition?: UploadFileWritePrecondition;
      },
    ) {
      const resolved = resolveFileKeyInput(input);
      const normalized = normalizeUploadInput(input);
      const storageInit = input.storageInit;

      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.findFirst("file", (b) =>
            b.whereIndex("idx_file_provider_key", (eb) =>
              eb.and(eb("provider", "=", normalized.provider), eb("key", "=", resolved.fileKey)),
            ),
          ),
        )
        .mutate(({ uow, retrieveResult: [existingFile] }) => {
          const databaseNow = uow.now();
          assertFileWritePrecondition(existingFile, input.precondition, {
            provider: normalized.provider,
            fileKey: resolved.fileKey,
          });

          if (existingFile?.objectKey === storageInit.storageKey) {
            throw new UploadServiceError(
              "STORAGE_ERROR",
              "A replacement upload must use a distinct storage object.",
            );
          }

          const finalSizeBytes = input.completedSizeBytes;
          const uploadRecord: UploadInsert = {
            key: resolved.fileKey,
            provider: normalized.provider,
            uploaderId: normalized.uploaderId,
            filename: normalized.filename,
            expectedSizeBytes: normalized.expectedSizeBytes,
            contentType: normalized.contentType,
            checksum: normalized.checksum,
            visibility: normalized.visibility,
            tags: normalized.tags,
            metadata: normalized.metadata,
            status: "completed",
            publicationMode: normalized.publicationMode,
            strategy: storageInit.strategy,
            objectKey: storageInit.storageKey,
            storageUploadId: storageInit.storageUploadId ?? null,
            uploadUrl: storageInit.uploadUrl ?? null,
            uploadHeaders: storageInit.uploadHeaders ?? null,
            bytesUploaded: finalSizeBytes,
            partsUploaded: 0,
            partSizeBytes: storageInit.partSizeBytes ?? null,
            expiresAt: storageInit.expiresAt,
            createdAt: databaseNow,
            updatedAt: databaseNow,
            completedAt: databaseNow,
            errorCode: null,
            errorMessage: null,
          };
          const uploadId = uow.create("upload", uploadRecord);
          const publication = planFilePublication(
            {
              id: uploadId,
              key: resolved.fileKey,
              provider: normalized.provider,
              uploaderId: normalized.uploaderId,
              filename: normalized.filename,
              expectedSizeBytes: normalized.expectedSizeBytes,
              contentType: normalized.contentType,
              checksum: normalized.checksum,
              visibility: normalized.visibility,
              tags: normalized.tags,
              metadata: normalized.metadata,
              objectKey: storageInit.storageKey,
            },
            existingFile,
            finalSizeBytes,
          );
          const persistedFileRecord = {
            ...publication.fileRecord,
            createdAt: databaseNow,
            updatedAt: databaseNow,
            completedAt: databaseNow,
          };

          uow.triggerHook("onFileReady", publication.readyHookPayload);
          uow.triggerHook("onFileTextIndexRequested", publication.readyHookPayload);

          if (existingFile) {
            uow.update("file", existingFile.id, (b) => b.set(persistedFileRecord).check());
            if (publication.supersededObjectHookPayload) {
              uow.triggerHook("cleanupStorageObject", publication.supersededObjectHookPayload);
            }
            return {
              file: {
                id: existingFile.id,
                ...publication.fileRecord,
                revision: existingFile.id.version + 1,
              },
            };
          }

          const fileId = uow.create("file", persistedFileRecord, {
            retryOnUniqueConflict: ({ error }) => error.kind === "unique",
          });
          return {
            file: { id: fileId, ...publication.fileRecord, revision: fileId.version },
          };
        })
        .build();
    },

    createFailedUpload: function (
      this: UploadServiceContext,
      input: CreateUploadInput & {
        storageInit: InitializedUpload;
        errorCode: string;
        errorMessage?: string | null;
      },
    ) {
      const resolved = resolveFileKeyInput(input);
      const normalized = normalizeUploadInput(input);
      const storageInit = input.storageInit;

      return this.serviceTx(uploadSchema)
        .mutate(({ uow }) => {
          const databaseNow = uow.now();
          const uploadRecord: UploadInsert = {
            key: resolved.fileKey,
            provider: normalized.provider,
            uploaderId: normalized.uploaderId,
            filename: normalized.filename,
            expectedSizeBytes: normalized.expectedSizeBytes,
            contentType: normalized.contentType,
            checksum: normalized.checksum,
            visibility: normalized.visibility,
            tags: normalized.tags,
            metadata: normalized.metadata,
            status: "failed",
            publicationMode: normalized.publicationMode,
            strategy: storageInit.strategy,
            objectKey: storageInit.storageKey,
            storageUploadId: storageInit.storageUploadId ?? null,
            uploadUrl: storageInit.uploadUrl ?? null,
            uploadHeaders: storageInit.uploadHeaders ?? null,
            bytesUploaded: 0n,
            partsUploaded: 0,
            partSizeBytes: storageInit.partSizeBytes ?? null,
            expiresAt: storageInit.expiresAt,
            createdAt: databaseNow,
            updatedAt: databaseNow,
            completedAt: null,
            errorCode: input.errorCode,
            errorMessage: input.errorMessage ?? null,
          };
          const uploadId = uow.create("upload", uploadRecord);

          uow.triggerHook("onUploadFailed", {
            provider: normalized.provider,
            fileKey: resolved.fileKey,
            objectKey: storageInit.storageKey,
            uploadId: uploadId.toString(),
            uploaderId: normalized.uploaderId,
            sizeBytes: normalized.sizeBytes,
            contentType: normalized.contentType,
          });

          return { uploadId };
        })
        .build();
    },

    getUpload: function (this: UploadServiceContext, uploadId: string) {
      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.findFirst("upload", (b) => b.whereIndex("primary", (eb) => eb("id", "=", uploadId))),
        )
        .transformRetrieve(([upload]) => {
          if (!upload) {
            throw new UploadServiceError("UPLOAD_NOT_FOUND", "The upload does not exist.");
          }
          return toUploadSnapshot(upload);
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
      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow
            .findFirst("upload", (b) => b.whereIndex("primary", (eb) => eb("id", "=", uploadId)))
            .findFirst("upload", (b) =>
              b.whereIndex("idx_upload_id_expiresAt", (eb) =>
                eb.and(eb("id", "=", uploadId), eb("expiresAt", ">", eb.now())),
              ),
            ),
        )
        .mutate(({ uow, retrieveResult: [uploadRow, unexpiredUpload] }) => {
          if (!uploadRow) {
            throw new UploadServiceError("UPLOAD_NOT_FOUND", "The upload does not exist.");
          }

          const upload = toUploadSnapshot(uploadRow);
          ensureActiveUpload(upload);
          if (!unexpiredUpload) {
            throw new UploadServiceError("UPLOAD_EXPIRED", "The upload has expired.");
          }

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
                updatedAt: uow.now(),
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
      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow
            .findFirst("upload", (b) => b.whereIndex("primary", (eb) => eb("id", "=", uploadId)))
            .findFirst("upload", (b) =>
              b.whereIndex("idx_upload_id_expiresAt", (eb) =>
                eb.and(eb("id", "=", uploadId), eb("expiresAt", ">", eb.now())),
              ),
            )
            .find("upload_part", (b) =>
              b.whereIndex("idx_upload_part_upload", (eb) => eb("uploadId", "=", uploadId)),
            ),
        )
        .mutate(({ uow, retrieveResult: [uploadRow, unexpiredUpload, parts] }) => {
          if (!uploadRow) {
            throw new UploadServiceError("UPLOAD_NOT_FOUND", "The upload does not exist.");
          }

          const upload = toUploadSnapshot(uploadRow);
          ensureActiveUpload(upload);
          if (!unexpiredUpload) {
            throw new UploadServiceError("UPLOAD_EXPIRED", "The upload has expired.");
          }
          ensureMultipartUpload(upload);

          const databaseNow = uow.now();
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
              createdAt: databaseNow,
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
                  updatedAt: databaseNow,
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

    completeUploadPublicationFromSnapshot: function (
      this: UploadServiceContext,
      upload: UploadSnapshot,
      options?: { sizeBytes?: bigint },
    ) {
      const finalSizeBytes = options?.sizeBytes ?? upload.expectedSizeBytes;

      if (upload.publicationMode === "batch") {
        return this.serviceTx(uploadSchema)
          .retrieve((uow) =>
            uow
              .findFirst("upload", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", upload.id.toString())),
              )
              .findFirst("upload", (b) =>
                b.whereIndex("idx_upload_id_expiresAt", (eb) =>
                  eb.and(eb("id", "=", upload.id.toString()), eb("expiresAt", ">", eb.now())),
                ),
              ),
          )
          .mutate(({ uow, retrieveResult: [currentUploadRow, unexpiredUpload] }) => {
            if (!currentUploadRow) {
              throw new UploadServiceError("UPLOAD_NOT_FOUND", "The upload does not exist.");
            }

            const currentUpload = toUploadSnapshot(currentUploadRow);
            ensureActiveUpload(currentUpload);
            if (!unexpiredUpload) {
              throw new UploadServiceError("UPLOAD_EXPIRED", "The upload has expired.");
            }

            const databaseNow = uow.now();
            uow.update("upload", currentUpload.id, (b) =>
              b
                .set({
                  status: "prepared",
                  bytesUploaded: finalSizeBytes,
                  updatedAt: databaseNow,
                  completedAt: databaseNow,
                })
                .check(),
            );

            return {
              kind: "prepared" as const,
              write: toPreparedFileWrite(currentUpload, finalSizeBytes),
            };
          })
          .build();
      }

      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow
            .findFirst("upload", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", upload.id.toString())),
            )
            .findFirst("upload", (b) =>
              b.whereIndex("idx_upload_id_expiresAt", (eb) =>
                eb.and(eb("id", "=", upload.id.toString()), eb("expiresAt", ">", eb.now())),
              ),
            )
            .findFirst("file", (b) =>
              b.whereIndex("idx_file_provider_key", (eb) =>
                eb.and(eb("provider", "=", upload.provider), eb("key", "=", upload.key)),
              ),
            ),
        )
        .mutate(({ uow, retrieveResult: [currentUploadRow, unexpiredUpload, existingFile] }) => {
          if (!currentUploadRow) {
            throw new UploadServiceError("UPLOAD_NOT_FOUND", "The upload does not exist.");
          }

          const currentUpload = toUploadSnapshot(currentUploadRow);
          ensureActiveUpload(currentUpload);
          if (!unexpiredUpload) {
            throw new UploadServiceError("UPLOAD_EXPIRED", "The upload has expired.");
          }

          const databaseNow = uow.now();
          const publication = planFilePublication(currentUpload, existingFile, finalSizeBytes);
          const persistedFileRecord = {
            ...publication.fileRecord,
            createdAt: databaseNow,
            updatedAt: databaseNow,
            completedAt: databaseNow,
          };

          uow.update("upload", currentUpload.id, (b) =>
            b
              .set({
                status: "completed",
                updatedAt: databaseNow,
                completedAt: databaseNow,
                bytesUploaded: finalSizeBytes,
              })
              .check(),
          );

          uow.triggerHook("onFileReady", publication.readyHookPayload);
          uow.triggerHook("onFileTextIndexRequested", publication.readyHookPayload);

          if (existingFile) {
            uow.update("file", existingFile.id, (b) => b.set(persistedFileRecord).check());
            if (publication.supersededObjectHookPayload) {
              uow.triggerHook("cleanupStorageObject", publication.supersededObjectHookPayload);
            }
            return {
              kind: "published" as const,
              file: {
                id: existingFile.id,
                ...publication.fileRecord,
                revision: existingFile.id.version + 1,
              },
            };
          }

          const fileId = uow.create("file", persistedFileRecord, {
            retryOnUniqueConflict: ({ error }) => error.kind === "unique",
          });
          return {
            kind: "published" as const,
            file: { id: fileId, ...publication.fileRecord, revision: fileId.version },
          };
        })
        .build();
    },

    commitPreparedFileWrites: function (
      this: UploadServiceContext,
      input: { entries: PreparedFileBatchEntry[]; activeProvider: string },
    ) {
      if (input.entries.length === 0 || input.entries.length > MAX_PREPARED_FILE_BATCH_ENTRIES) {
        throw new UploadServiceError(
          "INVALID_REQUEST",
          `Prepared file batches must contain between 1 and ${MAX_PREPARED_FILE_BATCH_ENTRIES} entries.`,
        );
      }

      const writes = input.entries.filter(
        (entry): entry is Extract<PreparedFileBatchEntry, { kind: "write" }> =>
          entry.kind === "write",
      );
      const deletions = input.entries.filter(
        (entry): entry is Extract<PreparedFileBatchEntry, { kind: "delete" }> =>
          entry.kind === "delete",
      );
      const assertions = input.entries.filter(
        (entry): entry is Extract<PreparedFileBatchEntry, { kind: "assert" }> =>
          entry.kind === "assert",
      );
      const uploadIds = writes.map((entry) => entry.uploadId);
      if (new Set(uploadIds).size !== uploadIds.length) {
        throw new UploadServiceError(
          "INVALID_REQUEST",
          "Prepared file batches cannot contain duplicate upload IDs.",
        );
      }

      const fileQueryGroups = new Map<string, string[]>();
      for (const entry of [...deletions, ...assertions]) {
        if (entry.provider !== input.activeProvider) {
          throw new UploadServiceError(
            "PROVIDER_MISMATCH",
            "A prepared batch entry belongs to a different provider.",
            { provider: entry.provider, fileKey: entry.fileKey },
          );
        }
        const keys = fileQueryGroups.get(entry.provider) ?? [];
        keys.push(entry.fileKey);
        fileQueryGroups.set(entry.provider, keys);
      }
      const uploadIdChunks = chunkBatchValues(uploadIds);
      const fileQueries = Array.from(fileQueryGroups, ([provider, keys]) =>
        chunkBatchValues(Array.from(new Set(keys))).map((fileKeys) => ({ provider, fileKeys })),
      ).flat();

      return this.serviceTx(uploadSchema)
        .retrieve((uow) => {
          const retrieval = uow as UploadMutationUnitOfWork;
          for (const ids of uploadIdChunks) {
            retrieval.find("upload", (b) =>
              b
                .whereIndex("primary", (eb) => eb("id", "in", ids))
                .joinOne("file", "file", (file) =>
                  file.onIndex("idx_file_provider_key", (eb) =>
                    eb.and(
                      eb("provider", "=", eb.parent("provider")),
                      eb("key", "=", eb.parent("key")),
                    ),
                  ),
                ),
            );
          }
          for (const ids of uploadIdChunks) {
            retrieval.find("upload", (b) =>
              b.whereIndex("idx_upload_id_expiresAt", (eb) =>
                eb.and(eb("id", "in", ids), eb("expiresAt", ">", eb.now())),
              ),
            );
          }
          for (const query of fileQueries) {
            retrieval.find("file", (b) =>
              b.whereIndex("idx_file_provider_key", (eb) =>
                eb.and(eb("provider", "=", query.provider), eb("key", "in", query.fileKeys)),
              ),
            );
          }
          return retrieval as TypedUnitOfWork<
            typeof uploadSchema,
            Array<UploadWithFile[] | UploadSnapshot[] | FileRow[]>,
            unknown,
            UploadHooks
          >;
        })
        .mutate(({ uow, retrieveResult }) => {
          const uploadResults = retrieveResult.slice(
            0,
            uploadIdChunks.length,
          ) as UploadWithFile[][];
          const unexpiredResultsStart = uploadIdChunks.length;
          const fileResultsStart = unexpiredResultsStart + uploadIdChunks.length;
          const unexpiredUploadResults = retrieveResult.slice(
            unexpiredResultsStart,
            fileResultsStart,
          ) as UploadSnapshot[][];
          const fileResults = retrieveResult.slice(fileResultsStart) as FileRow[][];
          const unexpiredUploadIds = new Set(
            unexpiredUploadResults.flat().map((upload) => upload.id.toString()),
          );
          const uploadsById = new Map(
            uploadResults.flat().map((upload) => [upload.id.toString(), upload]),
          );
          const filesByAddress = new Map([
            ...uploadResults
              .flat()
              .flatMap((upload) =>
                upload.file
                  ? [
                      [
                        batchFileAddress(upload.file.provider, upload.file.key),
                        upload.file,
                      ] as const,
                    ]
                  : [],
              ),
            ...fileResults
              .flat()
              .map((file) => [batchFileAddress(file.provider, file.key), file] as const),
          ]);

          const mutationDestinations = new Set<string>();
          const plans = writes.map((entry) => {
            const upload = uploadsById.get(entry.uploadId);
            if (!upload) {
              throw new UploadServiceError(
                "UPLOAD_NOT_FOUND",
                "The prepared upload does not exist.",
                { uploadId: entry.uploadId },
              );
            }

            if (upload.provider !== input.activeProvider) {
              throw new UploadServiceError(
                "PROVIDER_MISMATCH",
                "The prepared upload belongs to a different provider.",
                {
                  uploadId: entry.uploadId,
                  provider: upload.provider,
                  fileKey: upload.key,
                },
              );
            }

            const address = batchFileAddress(upload.provider, upload.key);
            if (mutationDestinations.has(address)) {
              throw new UploadServiceError(
                "INVALID_REQUEST",
                "Prepared file batches cannot contain duplicate mutation destinations.",
                {
                  uploadId: entry.uploadId,
                  provider: upload.provider,
                  fileKey: upload.key,
                },
              );
            }
            mutationDestinations.add(address);
            const file = upload.file ?? filesByAddress.get(address) ?? null;

            if (upload.status === "completed") {
              if (file?.status !== "ready" || file.objectKey !== upload.objectKey) {
                throw new UploadServiceError(
                  "UPLOAD_INVALID_STATE",
                  "The completed upload no longer publishes its expected storage object.",
                  {
                    uploadId: entry.uploadId,
                    provider: upload.provider,
                    fileKey: upload.key,
                  },
                );
              }
              return { entry, upload, file, alreadyCommitted: true as const };
            }
            if (upload.status === "expired" || !unexpiredUploadIds.has(entry.uploadId)) {
              throw new UploadServiceError("UPLOAD_EXPIRED", "The prepared upload has expired.", {
                uploadId: entry.uploadId,
                provider: upload.provider,
                fileKey: upload.key,
              });
            }
            if (upload.status !== "prepared") {
              throw new UploadServiceError(
                "UPLOAD_INVALID_STATE",
                `Uploads in the '${upload.status}' state cannot be committed as prepared files.`,
                {
                  uploadId: entry.uploadId,
                  provider: upload.provider,
                  fileKey: upload.key,
                },
              );
            }

            assertFileWritePrecondition(file, entry.precondition, {
              uploadId: entry.uploadId,
              provider: upload.provider,
              fileKey: upload.key,
            });
            const publication = planFilePublication(upload, file, upload.bytesUploaded);
            return { entry, upload, file, publication, alreadyCommitted: false as const };
          });

          const deletionPlans = deletions.map((entry) => {
            const address = batchFileAddress(entry.provider, entry.fileKey);
            if (mutationDestinations.has(address)) {
              throw new UploadServiceError(
                "INVALID_REQUEST",
                "Prepared file batches cannot contain duplicate mutation destinations.",
                { provider: entry.provider, fileKey: entry.fileKey },
              );
            }
            mutationDestinations.add(address);

            const file = filesByAddress.get(address) ?? null;
            if (file?.status === "deleted" && file.id.version === entry.precondition.revision + 1) {
              return { entry, file, alreadyDeleted: true as const };
            }

            assertFileWritePrecondition(file, entry.precondition, {
              provider: entry.provider,
              fileKey: entry.fileKey,
            });
            return { entry, file, alreadyDeleted: false as const };
          });

          for (const assertion of assertions) {
            const file =
              filesByAddress.get(batchFileAddress(assertion.provider, assertion.fileKey)) ?? null;
            assertFileWritePrecondition(file, assertion.precondition, {
              provider: assertion.provider,
              fileKey: assertion.fileKey,
            });
          }

          for (const assertion of assertions) {
            const file = filesByAddress.get(
              batchFileAddress(assertion.provider, assertion.fileKey),
            );
            if (file) {
              uow.check("file", file.id);
            } else {
              uow.checkAbsent("file", "idx_file_provider_key", {
                provider: assertion.provider,
                key: assertion.fileKey,
              });
            }
          }

          const databaseNow = uow.now();
          const writtenFiles = plans.map((plan) => {
            if (plan.alreadyCommitted) {
              uow.check("upload", plan.upload.id);
              uow.check("file", plan.file.id);
              return { ...plan.file, revision: plan.file.id.version };
            }

            uow.update("upload", plan.upload.id, (b) =>
              b.set({ status: "completed", updatedAt: databaseNow }).check(),
            );

            uow.triggerHook("onFileReady", plan.publication.readyHookPayload);
            uow.triggerHook("onFileTextIndexRequested", plan.publication.readyHookPayload);

            const persistedFileRecord = {
              ...plan.publication.fileRecord,
              createdAt: databaseNow,
              updatedAt: databaseNow,
              completedAt: databaseNow,
            };

            if (plan.file) {
              uow.update("file", plan.file.id, (b) => b.set(persistedFileRecord).check());
              if (plan.publication.supersededObjectHookPayload) {
                uow.triggerHook(
                  "cleanupStorageObject",
                  plan.publication.supersededObjectHookPayload,
                );
              }
              return {
                id: plan.file.id,
                ...plan.publication.fileRecord,
                revision: plan.file.id.version + 1,
              };
            }

            const fileId = uow.create("file", persistedFileRecord, {
              // Retrying the whole service transaction rechecks every batch precondition.
              retryOnUniqueConflict: ({ error }) => error.kind === "unique",
            });
            return {
              id: fileId,
              ...plan.publication.fileRecord,
              revision: fileId.version,
            };
          });
          const deletedFiles = deletionPlans.map((plan) => {
            if (plan.alreadyDeleted) {
              uow.check("file", plan.file.id);
              return { ...plan.file, revision: plan.file.id.version };
            }

            uow.update("file", plan.file.id, (b) =>
              b
                .set({
                  status: "deleted",
                  updatedAt: databaseNow,
                  deletedAt: databaseNow,
                })
                .check(),
            );
            uow.triggerHook("onFileDeleted", buildFileHookPayload(plan.file));
            return {
              ...plan.file,
              status: "deleted" as const,
              revision: plan.file.id.version + 1,
            };
          });

          return { files: [...writtenFiles, ...deletedFiles] };
        })
        .build();
    },

    markUploadFailed: function (
      this: UploadServiceContext,
      uploadId: string,
      errorCode: string,
      errorMessage?: string | null,
    ) {
      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.findFirst("upload", (b) => b.whereIndex("primary", (eb) => eb("id", "=", uploadId))),
        )
        .mutate(({ uow, retrieveResult: [uploadRow] }) => {
          if (!uploadRow) {
            throw new UploadServiceError("UPLOAD_NOT_FOUND", "The upload does not exist.");
          }

          const upload = toUploadSnapshot(uploadRow);
          if (isTerminalUploadStatus(upload.status)) {
            throw new UploadServiceError(
              "UPLOAD_INVALID_STATE",
              `Uploads in the '${upload.status}' state cannot fail.`,
            );
          }

          uow.update("upload", upload.id, (b) =>
            b
              .set({
                status: "failed",
                updatedAt: uow.now(),
                errorCode,
                errorMessage: errorMessage ?? null,
              })
              .check(),
          );

          uow.triggerHook("onUploadFailed", buildUploadHookPayload(upload));

          return { status: "failed" as const };
        })
        .build();
    },

    markUploadAborted: function (this: UploadServiceContext, uploadId: string) {
      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.findFirst("upload", (b) => b.whereIndex("primary", (eb) => eb("id", "=", uploadId))),
        )
        .mutate(({ uow, retrieveResult: [uploadRow] }) => {
          if (!uploadRow) {
            throw new UploadServiceError("UPLOAD_NOT_FOUND", "The upload does not exist.");
          }

          const upload = toUploadSnapshot(uploadRow);
          if (isTerminalUploadStatus(upload.status)) {
            throw new UploadServiceError(
              "UPLOAD_INVALID_STATE",
              `Uploads in the '${upload.status}' state cannot be aborted.`,
            );
          }

          uow.update("upload", upload.id, (b) =>
            b
              .set({
                status: "aborted",
                updatedAt: uow.now(),
                errorCode: "UPLOAD_ABORTED",
              })
              .check(),
          );

          if (upload.status === "prepared") {
            uow.triggerHook("cleanupStorageObject", buildUploadHookPayload(upload));
          }
          uow.triggerHook("onUploadFailed", buildUploadHookPayload(upload));

          return { status: "aborted" as const };
        })
        .build();
    },
  };
};
