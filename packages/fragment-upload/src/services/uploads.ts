import type { TypedUnitOfWork } from "@fragno-dev/db";

import { uploadExpiresInSeconds, type UploadFragmentConfig } from "../config";
import { uploadSchema } from "../schema";
import type { PreparedFileBatchEntry } from "../types";
import { assertFileSize, newObjectKey } from "./content";
import type { UploadHooks, UploadMutationUnitOfWork, UploadServiceContext } from "./context";
import { UploadServiceError } from "./errors";
import {
  assertFileWritePrecondition,
  buildUploadHookPayload,
  deleteFileContent,
  publishFileContent,
  type StoredFileRow,
  toPreparedFileWrite,
} from "./file-publication";
import { resolveFileKeyInput } from "./helpers";
import { chunkQueryValues } from "./query-chunks";
import {
  type CreateUploadInput,
  ensureActiveUpload,
  isTerminalUploadStatus,
  normalizeUploadInput,
  pickActiveUpload,
  type UploadSessionSnapshot,
  type UploadSnapshot,
  toUploadSnapshot,
  uploadMetadataMatches,
} from "./upload-model";

export const MAX_PREPARED_FILE_BATCH_ENTRIES = 5_000;

type UploadWithFile = UploadSnapshot & { file: StoredFileRow | null };

const batchFileAddress = (provider: string, fileKey: string) => `${provider}\0${fileKey}`;

export const createUploadServices = (config: UploadFragmentConfig) => {
  return {
    createUploadSession: function (this: UploadServiceContext, input: CreateUploadInput) {
      const resolved = resolveFileKeyInput(input);
      const normalized = normalizeUploadInput(input);
      assertFileSize(normalized.sizeBytes, config.maxFileBytes, `File '${resolved.fileKey}'`);
      const objectKey = newObjectKey(normalized.provider, resolved.fileKey);
      const expiresAt = new Date(Date.now() + uploadExpiresInSeconds(config) * 1000);

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
        .mutate(({ uow, retrieveResult: [uploadRows] }): UploadSessionSnapshot => {
          const activeUploads = uploadRows.map(toUploadSnapshot);
          const activeUpload = pickActiveUpload(activeUploads);
          if (activeUpload) {
            if (normalized.checksum !== null && uploadMetadataMatches(activeUpload, normalized)) {
              return activeUpload;
            }

            if (!input.replaceActiveUpload) {
              throw new UploadServiceError(
                "UPLOAD_ALREADY_ACTIVE",
                "An active upload already exists for this provider and file key.",
              );
            }

            // Active uploads hold no content yet: storing it completes or prepares them.
            for (const replaced of activeUploads) {
              uow.update("upload", replaced.id, (b) =>
                b
                  .set({
                    status: "aborted",
                    updatedAt: uow.now(),
                    errorCode: "UPLOAD_REPLACED",
                    errorMessage: "A newer upload of the same file replaced this one.",
                  })
                  .check(),
              );
              uow.triggerHook("onUploadFailed", buildUploadHookPayload(replaced));
            }
          }

          const databaseNow = uow.now();
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
            status: "created",
            publicationMode: normalized.publicationMode,
            objectKey,
            bytesUploaded: 0n,
            expiresAt,
            createdAt: databaseNow,
            updatedAt: databaseNow,
            completedAt: null,
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
            { processAt: expiresAt },
          );

          return {
            id: uploadId,
            key: resolved.fileKey,
            provider: normalized.provider,
            status: "created",
            publicationMode: normalized.publicationMode,
            expiresAt,
          };
        })
        .build();
    },

    /**
     * Stores the upload's content and, unless the upload is part of a batch, publishes it as the
     * file in the same transaction.
     */
    storeUploadContent: function (
      this: UploadServiceContext,
      uploadId: string,
      content: Uint8Array,
    ) {
      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow
            .findFirst("upload", (b) =>
              b
                .whereIndex("primary", (eb) => eb("id", "=", uploadId))
                .joinOne("file", "file", (file) =>
                  file
                    .onIndex("idx_file_provider_key", (eb) =>
                      eb.and(
                        eb("provider", "=", eb.parent("provider")),
                        eb("key", "=", eb.parent("key")),
                      ),
                    )
                    .joinOne("object", "storage_object", (object) =>
                      object
                        .onIndex("idx_storage_object_key", (eb) =>
                          eb("storageKey", "=", eb.parent("objectKey")),
                        )
                        .select(["id"]),
                    ),
                )
                .joinOne("object", "storage_object", (object) =>
                  object
                    .onIndex("idx_storage_object_key", (eb) =>
                      eb("storageKey", "=", eb.parent("objectKey")),
                    )
                    .select(["id"]),
                ),
            )
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
          const { file, object, ...row } = uploadRow;
          const upload = toUploadSnapshot(row);
          // A retried request finds its content already prepared.
          if (upload.status === "prepared" && upload.publicationMode === "batch") {
            return { kind: "prepared" as const, write: toPreparedFileWrite(upload) };
          }
          ensureActiveUpload(upload);
          if (!unexpiredUpload) {
            throw new UploadServiceError("UPLOAD_EXPIRED", "The upload has expired.");
          }

          const sizeBytes = BigInt(content.byteLength);
          const databaseNow = uow.now();
          const stored = { body: content, contentType: upload.contentType, sizeBytes };
          // Uploads stored their content apart from completing until storage moved into this
          // transaction, so an unfinished upload may already hold content from a failed attempt.
          if (object) {
            uow.update("storage_object", object.id, (b) =>
              b.set({ ...stored, updatedAt: databaseNow }).check(),
            );
          } else {
            uow.create("storage_object", { ...stored, storageKey: upload.objectKey });
          }
          const finished = {
            bytesUploaded: sizeBytes,
            updatedAt: databaseNow,
            completedAt: databaseNow,
          };

          if (upload.publicationMode === "batch") {
            uow.update("upload", upload.id, (b) =>
              b.set({ ...finished, status: "prepared" }).check(),
            );
            return {
              kind: "prepared" as const,
              write: toPreparedFileWrite({ ...upload, bytesUploaded: sizeBytes }),
            };
          }

          uow.update("upload", upload.id, (b) =>
            b.set({ ...finished, status: "completed" }).check(),
          );
          return {
            kind: "published" as const,
            file: publishFileContent(uow as UploadMutationUnitOfWork, file, {
              ...upload,
              sizeBytes,
              uploadId: upload.id.toString(),
            }),
          };
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

    getPreparedUploadContent: function (this: UploadServiceContext, uploadId: string) {
      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.findFirst("upload", (b) =>
            b
              .whereIndex("primary", (eb) => eb("id", "=", uploadId))
              .joinOne("object", "storage_object", (object) =>
                object.onIndex("idx_storage_object_key", (eb) =>
                  eb("storageKey", "=", eb.parent("objectKey")),
                ),
              ),
          ),
        )
        .transformRetrieve(([uploadRow]) => {
          if (!uploadRow) {
            throw new UploadServiceError("UPLOAD_NOT_FOUND", "The upload does not exist.");
          }
          const { object, ...row } = uploadRow;
          const upload = toUploadSnapshot(row);
          if (upload.status !== "prepared" || upload.publicationMode !== "batch") {
            throw new UploadServiceError(
              "UPLOAD_INVALID_STATE",
              "Only prepared batch uploads expose their content.",
            );
          }
          if (upload.expiresAt.getTime() <= Date.now()) {
            throw new UploadServiceError("UPLOAD_EXPIRED", "The upload has expired.");
          }
          if (!object) {
            throw new Error(`Prepared upload ${uploadId} has no stored content.`);
          }
          return { contentType: object.contentType, body: object.body };
        })
        .build();
    },

    commitPreparedFileWrites: function (
      this: UploadServiceContext,
      entries: PreparedFileBatchEntry[],
    ) {
      if (entries.length === 0 || entries.length > MAX_PREPARED_FILE_BATCH_ENTRIES) {
        throw new UploadServiceError(
          "INVALID_REQUEST",
          `Prepared file batches must contain between 1 and ${MAX_PREPARED_FILE_BATCH_ENTRIES} entries.`,
        );
      }

      const writes = entries.filter(
        (entry): entry is Extract<PreparedFileBatchEntry, { kind: "write" }> =>
          entry.kind === "write",
      );
      const deletions = entries.filter(
        (entry): entry is Extract<PreparedFileBatchEntry, { kind: "delete" }> =>
          entry.kind === "delete",
      );
      const assertions = entries.filter(
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
        const keys = fileQueryGroups.get(entry.provider) ?? [];
        keys.push(entry.fileKey);
        fileQueryGroups.set(entry.provider, keys);
      }
      const uploadIdChunks = chunkQueryValues(uploadIds);
      const fileQueries = Array.from(fileQueryGroups, ([provider, keys]) =>
        chunkQueryValues(Array.from(new Set(keys))).map((fileKeys) => ({ provider, fileKeys })),
      ).flat();

      return this.serviceTx(uploadSchema)
        .retrieve((uow) => {
          const retrieval = uow as UploadMutationUnitOfWork;
          for (const ids of uploadIdChunks) {
            retrieval.find("upload", (b) =>
              b
                .whereIndex("primary", (eb) => eb("id", "in", ids))
                .joinOne("file", "file", (file) =>
                  file
                    .onIndex("idx_file_provider_key", (eb) =>
                      eb.and(
                        eb("provider", "=", eb.parent("provider")),
                        eb("key", "=", eb.parent("key")),
                      ),
                    )
                    .joinOne("object", "storage_object", (object) =>
                      object
                        .onIndex("idx_storage_object_key", (eb) =>
                          eb("storageKey", "=", eb.parent("objectKey")),
                        )
                        .select(["id"]),
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
              b
                .whereIndex("idx_file_provider_key", (eb) =>
                  eb.and(eb("provider", "=", query.provider), eb("key", "in", query.fileKeys)),
                )
                .joinOne("object", "storage_object", (object) =>
                  object
                    .onIndex("idx_storage_object_key", (eb) =>
                      eb("storageKey", "=", eb.parent("objectKey")),
                    )
                    .select(["id"]),
                ),
            );
          }
          return retrieval as TypedUnitOfWork<
            typeof uploadSchema,
            Array<UploadWithFile[] | UploadSnapshot[] | StoredFileRow[]>,
            unknown,
            UploadHooks
          >;
        })
        .mutate(({ uow, retrieveResult }) => {
          const mutation = uow as UploadMutationUnitOfWork;
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
          const fileResults = retrieveResult.slice(fileResultsStart) as StoredFileRow[][];
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
                  "The completed upload no longer publishes its expected content.",
                  {
                    uploadId: entry.uploadId,
                    provider: upload.provider,
                    fileKey: upload.key,
                  },
                );
              }
              return { upload, file, alreadyCommitted: true as const };
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
            return { upload, file, alreadyCommitted: false as const };
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
              return { file, alreadyDeleted: true as const };
            }

            assertFileWritePrecondition(file, entry.precondition, {
              provider: entry.provider,
              fileKey: entry.fileKey,
            });
            return { file: file as StoredFileRow, alreadyDeleted: false as const };
          });

          for (const assertion of assertions) {
            const file =
              filesByAddress.get(batchFileAddress(assertion.provider, assertion.fileKey)) ?? null;
            assertFileWritePrecondition(file, assertion.precondition, {
              provider: assertion.provider,
              fileKey: assertion.fileKey,
            });
            if (file) {
              mutation.check("file", file.id);
            } else {
              mutation.checkAbsent("file", "idx_file_provider_key", {
                provider: assertion.provider,
                key: assertion.fileKey,
              });
            }
          }

          const databaseNow = mutation.now();
          const writtenFiles = plans.map((plan) => {
            if (plan.alreadyCommitted) {
              mutation.check("upload", plan.upload.id);
              mutation.check("file", plan.file.id);
              const { object: _object, ...file } = plan.file;
              return { ...file, revision: plan.file.id.version };
            }

            mutation.update("upload", plan.upload.id, (b) =>
              b.set({ status: "completed", updatedAt: databaseNow }).check(),
            );
            return publishFileContent(mutation, plan.file, {
              ...plan.upload,
              sizeBytes: plan.upload.bytesUploaded,
              uploadId: plan.upload.id.toString(),
            });
          });
          const deletedFiles = deletionPlans.map((plan) => {
            if (plan.alreadyDeleted) {
              mutation.check("file", plan.file.id);
              const { object: _object, ...file } = plan.file;
              return { ...file, revision: plan.file.id.version };
            }
            return deleteFileContent(mutation, plan.file);
          });

          return { files: [...writtenFiles, ...deletedFiles] };
        })
        .build();
    },

    markUploadAborted: function (this: UploadServiceContext, uploadId: string) {
      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.findFirst("upload", (b) =>
            b
              .whereIndex("primary", (eb) => eb("id", "=", uploadId))
              .joinOne("object", "storage_object", (object) =>
                object
                  .onIndex("idx_storage_object_key", (eb) =>
                    eb("storageKey", "=", eb.parent("objectKey")),
                  )
                  .select(["id"]),
              ),
          ),
        )
        .mutate(({ uow, retrieveResult: [uploadRow] }) => {
          if (!uploadRow) {
            throw new UploadServiceError("UPLOAD_NOT_FOUND", "The upload does not exist.");
          }

          const { object, ...row } = uploadRow;
          const upload = toUploadSnapshot(row);
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
          // Only prepared uploads hold content.
          if (object) {
            uow.delete("storage_object", object.id);
          }
          uow.triggerHook("onUploadFailed", buildUploadHookPayload(upload));

          return { status: "aborted" as const };
        })
        .build();
    },
  };
};
