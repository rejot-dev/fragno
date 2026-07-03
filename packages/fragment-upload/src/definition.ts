import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";

import type { FileHookPayload, UploadFragmentConfig, UploadTimeoutPayload } from "./config";
import { resolveUploadFragmentConfig } from "./config";
import { uploadSchema } from "./schema";
import { createFileServices, createUploadServices } from "./services";
import { buildTextIndex, shouldIndexContentType } from "./text-index";
import type { UploadStatus } from "./types";

const buildMissingDeletedFileObjectKeyError = (input: { provider: string; fileKey: string }) =>
  `Missing persisted objectKey for deleted file '${input.provider}:${input.fileKey}'. Refusing to reconstruct storage key from provider/fileKey.`;

const buildMissingCleanupObjectKeyError = (input: { provider: string; fileKey: string }) =>
  `Missing storage cleanup objectKey for '${input.provider}:${input.fileKey}'. Refusing to reconstruct storage key from provider/fileKey.`;

export const uploadFragmentDefinition = defineFragment<UploadFragmentConfig>("upload")
  .extend(withDatabase(uploadSchema))
  .withDependencies(({ config }) => ({
    resolvedConfig: resolveUploadFragmentConfig(config),
  }))
  .provideHooks(({ defineHook, config }) => {
    const resolvedConfig = resolveUploadFragmentConfig(config);

    return {
      onFileReady: defineHook(async function (payload: FileHookPayload) {
        await config.onFileReady?.(payload, this.idempotencyKey);
      }),
      onFileTextIndexRequested: defineHook(async function (payload: FileHookPayload) {
        if (!resolvedConfig.textIndex?.enabled) {
          return;
        }

        const objectKey =
          typeof payload.objectKey === "string" && payload.objectKey.length > 0
            ? payload.objectKey
            : null;

        if (!objectKey) {
          return;
        }

        if (!shouldIndexContentType(payload.contentType)) {
          await this.handlerTx()
            .retrieve(({ forSchema }) => {
              const uow = forSchema(uploadSchema);
              return uow
                .findFirst("file", (b) =>
                  b.whereIndex("idx_file_provider_key", (eb) =>
                    eb.and(eb("provider", "=", payload.provider), eb("key", "=", payload.fileKey)),
                  ),
                )
                .findFirst("file_text_document", (b) =>
                  b
                    .whereIndex("idx_file_text_document_provider_key", (eb) =>
                      eb.and(
                        eb("provider", "=", payload.provider),
                        eb("key", "=", payload.fileKey),
                      ),
                    )
                    .joinMany("terms", "file_text_term", (term) =>
                      term.onIndex("idx_file_text_term_document", (eb) =>
                        eb("documentId", "=", eb.parent("id")),
                      ),
                    ),
                );
            })
            .mutate(({ forSchema, retrieveResult: [file, document] }) => {
              if (!file || file.status !== "ready" || file.objectKey !== objectKey || !document) {
                return;
              }

              const uow = forSchema(uploadSchema);
              for (const term of document.terms) {
                uow.delete("file_text_term", term.id);
              }
              uow.delete("file_text_document", document.id);
            })
            .execute();
          return;
        }

        const response = await resolvedConfig.storage.getDownloadStream?.({
          storageKey: objectKey,
        });
        if (!response?.ok) {
          return;
        }

        const bytes = new Uint8Array(await response.arrayBuffer());
        const index = buildTextIndex(bytes, resolvedConfig.textIndex);

        await this.handlerTx()
          .retrieve(({ forSchema }) => {
            const uow = forSchema(uploadSchema);
            return uow
              .findFirst("file", (b) =>
                b.whereIndex("idx_file_provider_key", (eb) =>
                  eb.and(eb("provider", "=", payload.provider), eb("key", "=", payload.fileKey)),
                ),
              )
              .findFirst("file_text_document", (b) =>
                b
                  .whereIndex("idx_file_text_document_provider_key", (eb) =>
                    eb.and(eb("provider", "=", payload.provider), eb("key", "=", payload.fileKey)),
                  )
                  .joinMany("terms", "file_text_term", (term) =>
                    term.onIndex("idx_file_text_term_document", (eb) =>
                      eb("documentId", "=", eb.parent("id")),
                    ),
                  ),
              );
          })
          .mutate(({ forSchema, retrieveResult: [file, document] }) => {
            if (!file || file.status !== "ready" || file.objectKey !== objectKey) {
              return;
            }

            if (document?.contentHash === index.contentHash) {
              return;
            }

            const uow = forSchema(uploadSchema);
            const now = new Date();
            const documentId = document
              ? document.id
              : uow.create("file_text_document", {
                  fileId: file.id,
                  provider: file.provider,
                  key: file.key,
                  objectKey,
                  contentHash: index.contentHash,
                  byteLength: BigInt(index.byteLength),
                  indexedAt: now,
                  updatedAt: now,
                });

            if (document) {
              uow.update("file_text_document", document.id, (b) =>
                b.set({
                  fileId: file.id,
                  objectKey,
                  contentHash: index.contentHash,
                  byteLength: BigInt(index.byteLength),
                  indexedAt: now,
                  updatedAt: now,
                }),
              );

              for (const term of document.terms) {
                uow.delete("file_text_term", term.id);
              }
            }

            for (const term of index.terms) {
              uow.create("file_text_term", {
                documentId,
                provider: file.provider,
                key: file.key,
                term: term.term,
                positions: term.positions,
                count: term.count,
              });
            }
          })
          .execute();
      }),
      onUploadFailed: defineHook(async function (payload: FileHookPayload) {
        await config.onUploadFailed?.(payload, this.idempotencyKey);
      }),
      cleanupStorageObject: defineHook(async function (payload: FileHookPayload) {
        const objectKey =
          typeof payload.objectKey === "string" && payload.objectKey.length > 0
            ? payload.objectKey
            : null;

        if (!objectKey) {
          throw new Error(
            buildMissingCleanupObjectKeyError({
              provider: payload.provider,
              fileKey: payload.fileKey,
            }),
          );
        }

        await resolvedConfig.storage.deleteObject({ storageKey: objectKey });
      }),
      onFileDeleted: defineHook(async function (payload: FileHookPayload) {
        const payloadObjectKey =
          typeof payload.objectKey === "string" && payload.objectKey.length > 0
            ? payload.objectKey
            : undefined;
        const resolvePersistedObjectKey = (
          file: { status: string; objectKey?: string | null } | null | undefined,
        ) => {
          if (payloadObjectKey) {
            return payloadObjectKey;
          }

          if (
            file?.status === "deleted" &&
            typeof file.objectKey === "string" &&
            file.objectKey.length > 0
          ) {
            return file.objectKey;
          }

          return null;
        };

        const missingPersistedObjectKeyError = () =>
          new Error(
            buildMissingDeletedFileObjectKeyError({
              provider: payload.provider,
              fileKey: payload.fileKey,
            }),
          );

        const { persistedObjectKey } = await this.handlerTx()
          .retrieve(({ forSchema }) => {
            const uow = forSchema(uploadSchema);
            return uow
              .findFirst("file", (b) =>
                b.whereIndex("idx_file_provider_key", (eb) =>
                  eb.and(eb("provider", "=", payload.provider), eb("key", "=", payload.fileKey)),
                ),
              )
              .findFirst("file_text_document", (b) =>
                b
                  .whereIndex("idx_file_text_document_provider_key", (eb) =>
                    eb.and(eb("provider", "=", payload.provider), eb("key", "=", payload.fileKey)),
                  )
                  .joinMany("terms", "file_text_term", (term) =>
                    term.onIndex("idx_file_text_term_document", (eb) =>
                      eb("documentId", "=", eb.parent("id")),
                    ),
                  ),
              );
          })
          .afterRetrieve(async (_uow, [file]) => {
            const persistedObjectKey = resolvePersistedObjectKey(file);
            if (!persistedObjectKey) {
              throw missingPersistedObjectKeyError();
            }

            await resolvedConfig.storage.deleteObject({ storageKey: persistedObjectKey });
          })
          .mutate(({ forSchema, retrieveResult: [file, document] }) => {
            const persistedObjectKey = resolvePersistedObjectKey(file);
            if (!persistedObjectKey) {
              throw missingPersistedObjectKeyError();
            }

            if (document?.objectKey === persistedObjectKey) {
              const uow = forSchema(uploadSchema);
              for (const term of document.terms) {
                uow.delete("file_text_term", term.id);
              }
              uow.delete("file_text_document", document.id);
            }

            return { persistedObjectKey };
          })
          .execute();

        await config.onFileDeleted?.(
          {
            ...payload,
            objectKey: persistedObjectKey,
          },
          this.idempotencyKey,
        );
      }),
      onUploadTimeout: defineHook(async function (payload: UploadTimeoutPayload) {
        const now = new Date();

        if (!payload.uploadId) {
          return;
        }

        const result = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(uploadSchema).findFirst("upload", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", payload.uploadId)),
            ),
          )
          .mutate(({ forSchema, retrieveResult: [upload] }) => {
            if (!upload) {
              return { shouldNotify: false as const };
            }

            const status = upload.status as UploadStatus;
            if (
              status === "completed" ||
              status === "aborted" ||
              status === "failed" ||
              status === "expired"
            ) {
              return { shouldNotify: false as const };
            }

            if (upload.expiresAt.getTime() > now.getTime()) {
              return { shouldNotify: false as const };
            }

            const uow = forSchema(uploadSchema);
            uow.update("upload", upload.id, (b) =>
              b.set({
                status: "expired",
                updatedAt: now,
                errorCode: "UPLOAD_EXPIRED",
                errorMessage: "Upload expired",
              }),
            );

            return {
              shouldNotify: true as const,
              payload: {
                provider: upload.provider,
                fileKey: upload.key,
                objectKey: upload.objectKey,
                uploadId: payload.uploadId,
                uploaderId: upload.uploaderId,
                sizeBytes: Number(upload.expectedSizeBytes),
                contentType: upload.contentType,
              },
            };
          })
          .transform(({ mutateResult }) => mutateResult)
          .execute();

        if (result.shouldNotify) {
          await config.onUploadFailed?.(result.payload, this.idempotencyKey);
        }
      }),
    };
  })
  .providesBaseService(({ defineService, deps }) => {
    return defineService({
      ...createUploadServices(deps.resolvedConfig),
      ...createFileServices(deps.resolvedConfig),
    });
  })
  .build();
