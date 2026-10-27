import { defineRoutes } from "@fragno-dev/core";

import { uploadFragmentDefinition } from "../definition";
import { readContent } from "../services/content";
import { toFileMutationResult, uploadCompletionResultSchema } from "./shared";
import {
  abortUploadOutputSchema,
  createUploadInputSchema,
  createUploadOutputSchema,
  uploadStatusOutputSchema,
} from "./uploads-contracts";
import { handleUploadServiceError, uploadErrorCodes } from "./uploads-errors";

export const uploadRoutesFactory = defineRoutes(uploadFragmentDefinition).create(
  ({ services, defineRoute, config }) => {
    return [
      defineRoute({
        method: "POST",
        path: "/uploads",
        inputSchema: createUploadInputSchema,
        outputSchema: createUploadOutputSchema,
        errorCodes: uploadErrorCodes,
        handler: async function createUploadSession({ input }, { json, error }) {
          const payload = await input.valid();
          try {
            const upload = await this.handlerTx()
              .withServiceCalls(() => [services.createUploadSession(payload)])
              .transform(({ serviceResult: [created] }) => created)
              .execute();

            return json({
              uploadId: upload.id.toString(),
              fileKey: upload.key,
              provider: upload.provider,
              status: upload.status,
              publicationMode: upload.publicationMode,
              expiresAt: upload.expiresAt,
            });
          } catch (err) {
            return handleUploadServiceError(err, error);
          }
        },
      }),

      defineRoute({
        method: "GET",
        path: "/uploads/:uploadId",
        outputSchema: uploadStatusOutputSchema,
        errorCodes: uploadErrorCodes,
        handler: async function getUploadSessionStatus({ pathParams }, { json, error }) {
          try {
            const upload = await this.handlerTx()
              .withServiceCalls(() => [services.getUpload(pathParams.uploadId)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            return json({
              uploadId: upload.id.toString(),
              fileKey: upload.key,
              provider: upload.provider,
              status: upload.status,
              publicationMode: upload.publicationMode,
              expectedSizeBytes: Number(upload.expectedSizeBytes),
              bytesUploaded: Number(upload.bytesUploaded),
              expiresAt: upload.expiresAt,
              createdAt: upload.createdAt,
              updatedAt: upload.updatedAt,
              completedAt: upload.completedAt,
              errorCode: upload.errorCode,
              errorMessage: upload.errorMessage,
            });
          } catch (err) {
            return handleUploadServiceError(err, error);
          }
        },
      }),

      defineRoute({
        method: "POST",
        path: "/uploads/:uploadId/abort",
        outputSchema: abortUploadOutputSchema,
        errorCodes: uploadErrorCodes,
        handler: async function abortUploadSession({ pathParams }, { json, error }) {
          try {
            await this.handlerTx()
              .withServiceCalls(() => [services.markUploadAborted(pathParams.uploadId)])
              .execute();

            return json({ ok: true });
          } catch (err) {
            return handleUploadServiceError(err, error);
          }
        },
      }),

      defineRoute({
        method: "GET",
        path: "/uploads/:uploadId/content",
        errorCodes: uploadErrorCodes,
        handler: async function readPreparedUploadContent({ pathParams }, { error }) {
          try {
            const content = await this.handlerTx()
              .withServiceCalls(() => [services.getPreparedUploadContent(pathParams.uploadId)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            return new Response(content.body.slice(), {
              headers: {
                "Content-Type": content.contentType,
                "Content-Length": String(content.body.byteLength),
              },
            });
          } catch (cause) {
            return handleUploadServiceError(cause, error);
          }
        },
      }),

      defineRoute({
        method: "PUT",
        path: "/uploads/:uploadId/content",
        contentType: "application/octet-stream",
        outputSchema: uploadCompletionResultSchema,
        errorCodes: uploadErrorCodes,
        handler: async function storeUploadContent(context, { json, error }) {
          const { uploadId } = context.pathParams;
          try {
            const content = await readContent(
              context.bodyStream(),
              config.maxFileBytes,
              `Upload ${uploadId}`,
            );
            const stored = await this.handlerTx()
              .withServiceCalls(() => [services.storeUploadContent(uploadId, content)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            if (stored.kind === "prepared") {
              return json(stored);
            }
            return json({ kind: "published", file: toFileMutationResult(stored.file) });
          } catch (err) {
            return handleUploadServiceError(err, error);
          }
        },
      }),
    ];
  },
);
