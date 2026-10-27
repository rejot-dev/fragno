import { defineFragment } from "@fragno-dev/core";
import { withDatabase, type DatabaseHandlerTx } from "@fragno-dev/db";

import type {
  FileHookPayload,
  UnfinishedUploadPayload,
  UploadFragmentConfig,
  UploadTimeoutPayload,
} from "./config";
import { uploadSchema } from "./schema";
import { createFileServices } from "./services/files";
import { createUploadServices } from "./services/uploads";
import { buildTextIndex, shouldIndexContentType } from "./text-index";
import type { UploadStatus } from "./types";

/**
 * Deletes content its file or upload no longer needs. Writes delete the content they replace in
 * their own transaction; the hooks using this serve events queued before they did.
 */
async function deleteStoredObject(handlerTx: DatabaseHandlerTx, objectKey: string | undefined) {
  if (!objectKey) {
    return;
  }
  await handlerTx()
    .retrieve(({ forSchema }) =>
      forSchema(uploadSchema).findFirst("storage_object", (b) =>
        b
          .whereIndex("idx_storage_object_key", (eb) => eb("storageKey", "=", objectKey))
          .select(["id"]),
      ),
    )
    .mutate(({ forSchema, retrieveResult: [object] }) => {
      if (object) {
        forSchema(uploadSchema).delete("storage_object", object.id);
      }
    })
    .execute();
}

export const uploadFragmentDefinition = defineFragment<UploadFragmentConfig>("upload")
  .extend(withDatabase(uploadSchema))
  .provideHooks(({ defineHook, config }) => {
    return {
      onFileReady: defineHook(async function (payload: FileHookPayload) {
        await config.onFileReady?.(payload, this.idempotencyKey);
      }),
      onFileTextIndexRequested: defineHook(async function (payload: FileHookPayload) {
        if (!config.textIndex?.enabled || !payload.objectKey) {
          return;
        }
        const objectKey = payload.objectKey;

        await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(uploadSchema)
              .findFirst("file", (b) =>
                b.whereIndex("idx_file_provider_key", (eb) =>
                  eb.and(eb("provider", "=", payload.provider), eb("key", "=", payload.fileKey)),
                ),
              )
              .findFirst("storage_object", (b) =>
                b.whereIndex("idx_storage_object_key", (eb) => eb("storageKey", "=", objectKey)),
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
              ),
          )
          .mutate(({ forSchema, retrieveResult: [file, object, document] }) => {
            // A later write publishes other content, and indexes it itself.
            if (file?.status !== "ready" || file.objectKey !== objectKey) {
              return;
            }

            const uow = forSchema(uploadSchema);
            if (!object || !shouldIndexContentType(file.contentType)) {
              if (document) {
                for (const term of document.terms) {
                  uow.delete("file_text_term", term.id);
                }
                uow.delete("file_text_document", document.id);
              }
              return;
            }

            const index = buildTextIndex(object.body, config.textIndex);
            if (document?.contentHash === index.contentHash) {
              return;
            }

            const now = uow.now();
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
      cleanupStorageObject: defineHook(async function ({ objectKey }: FileHookPayload) {
        await deleteStoredObject((options) => this.handlerTx(options), objectKey);
      }),
      cleanupUnfinishedUpload: defineHook(async function ({ objectKey }: UnfinishedUploadPayload) {
        await deleteStoredObject((options) => this.handlerTx(options), objectKey);
      }),
      onFileDeleted: defineHook(async function (payload: FileHookPayload) {
        const objectKey = payload.objectKey ?? "";
        await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(uploadSchema)
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
              )
              .findFirst("storage_object", (b) =>
                b
                  .whereIndex("idx_storage_object_key", (eb) => eb("storageKey", "=", objectKey))
                  .select(["id"]),
              ),
          )
          .mutate(({ forSchema, retrieveResult: [document, object] }) => {
            const uow = forSchema(uploadSchema);
            // Deletes delete their content themselves, but this hook deleted it for deletes
            // queued before they did.
            if (object) {
              uow.delete("storage_object", object.id);
            }
            if (!document || document.objectKey !== payload.objectKey) {
              return;
            }
            for (const term of document.terms) {
              uow.delete("file_text_term", term.id);
            }
            uow.delete("file_text_document", document.id);
          })
          .execute();

        await config.onFileDeleted?.(payload, this.idempotencyKey);
      }),
      onUploadTimeout: defineHook(async function (payload: UploadTimeoutPayload) {
        const result = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(uploadSchema)
              .findFirst("upload", (b) =>
                b
                  .whereIndex("primary", (eb) => eb("id", "=", payload.uploadId))
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
                  eb.and(eb("id", "=", payload.uploadId), eb("expiresAt", "<=", eb.now())),
                ),
              ),
          )
          .mutate(({ forSchema, retrieveResult: [upload, expiredUpload] }) => {
            const status = upload?.status as UploadStatus | undefined;
            if (
              !upload ||
              !expiredUpload ||
              status === "completed" ||
              status === "aborted" ||
              status === "failed" ||
              status === "expired"
            ) {
              return { shouldNotify: false as const };
            }

            const uow = forSchema(uploadSchema);
            // Prepared content never published once its batch can no longer commit.
            if (upload.object) {
              uow.delete("storage_object", upload.object.id);
            }
            uow.update("upload", upload.id, (b) =>
              b
                .set({
                  status: "expired",
                  updatedAt: uow.now(),
                  errorCode: "UPLOAD_EXPIRED",
                  errorMessage: "Upload expired",
                })
                .check(),
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
  .providesBaseService(({ defineService, config }) => {
    return defineService({
      ...createUploadServices(config),
      ...createFileServices(config),
    });
  })
  .build();
