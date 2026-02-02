import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import type { UploadFragmentConfig } from "./config";
import { resolveUploadFragmentConfig } from "./config";
import { uploadSchema } from "./schema";
import { createFileServices, createUploadServices } from "./services";
import type { UploadStatus, FileStatus } from "./types";

export const uploadFragmentDefinition = defineFragment<UploadFragmentConfig>("upload")
  .extend(withDatabase(uploadSchema))
  .withDependencies(({ config }) => ({
    resolvedConfig: resolveUploadFragmentConfig(config),
  }))
  .provideHooks(({ defineHook, config }) => {
    return {
      onFileReady: defineHook(async function (payload) {
        await config.onFileReady?.(payload, this.idempotencyKey);
      }),
      onUploadFailed: defineHook(async function (payload) {
        await config.onUploadFailed?.(payload, this.idempotencyKey);
      }),
      onFileDeleted: defineHook(async function (payload) {
        await config.onFileDeleted?.(payload, this.idempotencyKey);
      }),
      onUploadTimeout: defineHook(async function (payload) {
        const now = new Date();

        if (!payload.uploadId) {
          return;
        }

        const result = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(uploadSchema)
              .findFirst("upload", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", payload.uploadId)),
              )
              .findFirst("file", (b) =>
                b.whereIndex("idx_file_key", (eb) => eb("fileKey", "=", payload.fileKey)),
              ),
          )
          .mutate(({ forSchema, retrieveResult: [upload, file] }) => {
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

            if (!file) {
              return { shouldNotify: false as const };
            }

            const fileStatus = file.status as FileStatus;
            if (fileStatus === "ready" || fileStatus === "deleted") {
              return { shouldNotify: false as const };
            }

            uow.update("file", file.id, (b) =>
              b.set({
                status: "failed",
                updatedAt: now,
                errorCode: "UPLOAD_EXPIRED",
                errorMessage: "Upload expired",
              }),
            );

            return {
              shouldNotify: true as const,
              payload: {
                fileKey: file.fileKey,
                fileKeyParts: payload.fileKeyParts,
                uploadId: payload.uploadId,
                uploaderId: file.uploaderId,
                sizeBytes: Number(file.sizeBytes),
                contentType: file.contentType,
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
