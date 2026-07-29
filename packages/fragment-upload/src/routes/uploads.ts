import { defineRoutes } from "@fragno-dev/core";

import { resolveUploadFragmentConfig } from "../config";
import { uploadFragmentDefinition } from "../definition";
import { UploadServiceError } from "../services/errors";
import { toPreparedFileWrite } from "../services/file-publication";
import { resolveFileKeyInput } from "../services/helpers";
import { buildStorageObjectVersionSegment } from "../storage/object-key";
import type { UploadPublicationMode, UploadStatus } from "../types";
import { toFileMutationResult, uploadCompletionResultSchema } from "./shared";
import {
  abortUploadOutputSchema,
  completedUploadPartsInputSchema,
  completeUploadInputSchema,
  createUploadInputSchema,
  createUploadOutputSchema,
  uploadPartNumbersInputSchema,
  uploadPartsOutputSchema,
  uploadPartUrlsOutputSchema,
  uploadProgressInputSchema,
  uploadProgressOutputSchema,
  uploadStatusOutputSchema,
} from "./uploads-contracts";
import {
  handleUploadServiceError,
  rejectInactiveUpload,
  rejectProviderMismatch,
  uploadErrorCodes,
} from "./uploads-errors";
import { buildUploadSessionRouteData, toCreateUploadResult } from "./uploads-results";
import {
  abortMultipartUploadObject,
  discardUnusedMultipartUpload,
  finalizeDirectUploadObject,
  issueMultipartPartUploadUrls,
  mapStorageOperationError,
  storeProxyUploadObject,
} from "./uploads-storage";

function isPreparedBatchUpload(upload: {
  status: UploadStatus;
  publicationMode: UploadPublicationMode;
}): boolean {
  return upload.status === "prepared" && upload.publicationMode === "batch";
}

export const uploadRoutesFactory = defineRoutes(uploadFragmentDefinition).create(
  ({ services, defineRoute, config }) => {
    const getResolvedConfig = () => resolveUploadFragmentConfig(config);

    return [
      defineRoute({
        method: "POST",
        path: "/uploads",
        inputSchema: createUploadInputSchema,
        outputSchema: createUploadOutputSchema,
        errorCodes: uploadErrorCodes,
        handler: async function createUploadSession({ input }, { json, error }) {
          const payload = await input.valid();
          const resolvedConfig = getResolvedConfig();
          const provider = payload.provider ?? resolvedConfig.storage.name;

          let resolvedKey;
          try {
            resolvedKey = resolveFileKeyInput({
              keyParts: payload.keyParts,
              fileKey: payload.fileKey,
            });
          } catch (err) {
            return handleUploadServiceError(err, error);
          }

          const objectKeyVersionSegment = buildStorageObjectVersionSegment();

          let storageInit;
          try {
            storageInit = await resolvedConfig.storage.initUpload({
              provider,
              fileKey: resolvedKey.fileKey,
              sizeBytes: BigInt(payload.sizeBytes),
              contentType: payload.contentType,
              checksum: payload.checksum ?? null,
              metadata: payload.metadata ?? null,
              objectKeyVersionSegment,
            });
          } catch (cause) {
            return handleUploadServiceError(mapStorageOperationError(cause), error);
          }

          try {
            const result = await this.handlerTx()
              .withServiceCalls(() => [
                services.createUploadRecord({
                  ...payload,
                  provider,
                  storageInit,
                  allowIdempotentReuse: true,
                }),
              ])
              .transform(({ serviceResult: [created] }) => created)
              .execute();

            if (result.reused) {
              await discardUnusedMultipartUpload(resolvedConfig.storage, storageInit);
            }

            return json(toCreateUploadResult(resolvedConfig.storage, result.upload));
          } catch (err) {
            await discardUnusedMultipartUpload(resolvedConfig.storage, storageInit);
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
          const resolvedConfig = getResolvedConfig();
          try {
            const upload = await this.handlerTx()
              .withServiceCalls(() => [services.getUpload(pathParams.uploadId)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            return json({
              uploadId: upload.id.toString(),
              fileKey: upload.key,
              ...buildUploadSessionRouteData(resolvedConfig.storage, {
                uploadId: upload.id.toString(),
                provider: upload.provider,
                strategy: upload.strategy,
                uploadUrl: upload.uploadUrl ?? undefined,
                uploadHeaders: upload.uploadHeaders ?? undefined,
                partSizeBytes: upload.partSizeBytes ?? undefined,
              }),
              status: upload.status,
              strategy: upload.strategy,
              publicationMode: upload.publicationMode,
              expectedSizeBytes: Number(upload.expectedSizeBytes),
              bytesUploaded: Number(upload.bytesUploaded),
              partsUploaded: upload.partsUploaded,
              partSizeBytes: upload.partSizeBytes,
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
        path: "/uploads/:uploadId/progress",
        inputSchema: uploadProgressInputSchema,
        outputSchema: uploadProgressOutputSchema,
        errorCodes: uploadErrorCodes,
        handler: async function recordUploadProgress({ pathParams, input }, { json, error }) {
          const payload = await input.valid();
          try {
            const result = await this.handlerTx()
              .withServiceCalls(() => [services.recordUploadProgress(pathParams.uploadId, payload)])
              .transform(({ serviceResult: [updated] }) => updated)
              .execute();

            return json({
              bytesUploaded: Number(result.bytesUploaded),
              partsUploaded: result.partsUploaded,
            });
          } catch (err) {
            return handleUploadServiceError(err, error);
          }
        },
      }),

      defineRoute({
        method: "POST",
        path: "/uploads/:uploadId/parts",
        inputSchema: uploadPartNumbersInputSchema,
        outputSchema: uploadPartUrlsOutputSchema,
        errorCodes: uploadErrorCodes,
        handler: async function createUploadPartUrls({ pathParams, input }, { json, error }) {
          const payload = await input.valid();
          const resolvedConfig = getResolvedConfig();
          try {
            // Rule of Fragno exception: read -> storage I/O -> mutate.
            const upload = await this.handlerTx()
              .withServiceCalls(() => [services.getUpload(pathParams.uploadId)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            const providerMismatch = rejectProviderMismatch(
              upload,
              resolvedConfig.storage.name,
              error,
            );
            if (providerMismatch) {
              return providerMismatch;
            }

            if (upload.strategy !== "direct-multipart") {
              return error({ message: "Upload invalid state", code: "UPLOAD_INVALID_STATE" }, 409);
            }

            const parts = await issueMultipartPartUploadUrls(
              resolvedConfig.storage,
              upload,
              payload.partNumbers,
            );

            return json({ parts });
          } catch (err) {
            return handleUploadServiceError(err, error);
          }
        },
      }),

      defineRoute({
        method: "GET",
        path: "/uploads/:uploadId/parts",
        outputSchema: uploadPartsOutputSchema,
        errorCodes: uploadErrorCodes,
        handler: async function listUploadParts({ pathParams }, { json, error }) {
          try {
            const parts = await this.handlerTx()
              .withServiceCalls(() => [services.getUploadParts(pathParams.uploadId)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            const typedParts = parts as {
              partNumber: number;
              etag: string;
              sizeBytes: bigint;
              createdAt: Date;
            }[];

            return json({
              parts: typedParts.map((part) => ({
                partNumber: part.partNumber,
                etag: part.etag,
                sizeBytes: Number(part.sizeBytes),
                createdAt: part.createdAt,
              })),
            });
          } catch (err) {
            return handleUploadServiceError(err, error);
          }
        },
      }),

      defineRoute({
        method: "POST",
        path: "/uploads/:uploadId/parts/complete",
        inputSchema: completedUploadPartsInputSchema,
        outputSchema: uploadProgressOutputSchema,
        errorCodes: uploadErrorCodes,
        handler: async function recordCompletedUploadParts({ pathParams, input }, { json, error }) {
          const payload = await input.valid();
          try {
            const result = await this.handlerTx()
              .withServiceCalls(() => [services.recordUploadParts(pathParams.uploadId, payload)])
              .transform(({ serviceResult: [updated] }) => updated)
              .execute();

            return json({
              bytesUploaded: Number(result.bytesUploaded),
              partsUploaded: result.partsUploaded,
            });
          } catch (err) {
            return handleUploadServiceError(err, error);
          }
        },
      }),

      defineRoute({
        method: "POST",
        path: "/uploads/:uploadId/complete",
        inputSchema: completeUploadInputSchema,
        outputSchema: uploadCompletionResultSchema,
        errorCodes: uploadErrorCodes,
        handler: async function completeDirectUpload({ pathParams, input }, { json, error }) {
          const payload = await input.valid();
          const resolvedConfig = getResolvedConfig();
          try {
            // Rule of Fragno exception: read -> storage I/O -> mutate.
            const upload = await this.handlerTx()
              .withServiceCalls(() => [services.getUpload(pathParams.uploadId)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            const providerMismatch = rejectProviderMismatch(
              upload,
              resolvedConfig.storage.name,
              error,
            );
            if (providerMismatch) {
              return providerMismatch;
            }
            if (isPreparedBatchUpload(upload)) {
              return json({ kind: "prepared", write: toPreparedFileWrite(upload) });
            }

            const inactiveResponse = rejectInactiveUpload(
              {
                status: upload.status,
                expiresAt: upload.expiresAt,
              },
              error,
            );
            if (inactiveResponse) {
              return inactiveResponse;
            }

            const finalizedSizeBytes = await finalizeDirectUploadObject(
              resolvedConfig.storage,
              upload,
              payload.parts,
            );
            const completionOptions =
              finalizedSizeBytes === undefined ? undefined : { sizeBytes: finalizedSizeBytes };

            const completion = await this.handlerTx()
              .withServiceCalls(() => [
                services.completeUploadPublicationFromSnapshot(upload, completionOptions),
              ])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            if (completion.kind === "prepared") {
              return json(completion);
            }
            return json({ kind: "published", file: toFileMutationResult(completion.file) });
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
          const resolvedConfig = getResolvedConfig();
          try {
            // Rule of Fragno exception: read -> storage I/O -> mutate.
            const upload = await this.handlerTx()
              .withServiceCalls(() => [services.getUpload(pathParams.uploadId)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            const providerMismatch = rejectProviderMismatch(
              upload,
              resolvedConfig.storage.name,
              error,
            );
            if (providerMismatch) {
              return providerMismatch;
            }

            if (upload.status !== "prepared" && upload.strategy === "direct-multipart") {
              await abortMultipartUploadObject(resolvedConfig.storage, upload);
            }

            await this.handlerTx()
              .withServiceCalls(() => [services.markUploadAborted(upload.id.toString())])
              .execute();

            return json({ ok: true });
          } catch (err) {
            return handleUploadServiceError(err, error);
          }
        },
      }),

      defineRoute({
        method: "PUT",
        path: "/uploads/:uploadId/content",
        contentType: "application/octet-stream",
        outputSchema: uploadCompletionResultSchema,
        errorCodes: uploadErrorCodes,
        handler: async function uploadProxyContent(context, { json, error }) {
          const { pathParams } = context;
          if (context.query.has("completionMode")) {
            return error({ message: "Invalid request", code: "INVALID_REQUEST" }, 400);
          }
          const resolvedConfig = getResolvedConfig();
          try {
            // Rule of Fragno exception: read -> storage I/O -> mutate.
            const upload = await this.handlerTx()
              .withServiceCalls(() => [services.getUpload(pathParams.uploadId)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            const providerMismatch = rejectProviderMismatch(
              upload,
              resolvedConfig.storage.name,
              error,
            );
            if (providerMismatch) {
              return providerMismatch;
            }

            if (upload.strategy !== "proxy") {
              return error({ message: "Upload invalid state", code: "UPLOAD_INVALID_STATE" }, 409);
            }
            if (isPreparedBatchUpload(upload)) {
              return json({ kind: "prepared", write: toPreparedFileWrite(upload) });
            }

            const inactiveResponse = rejectInactiveUpload(
              {
                status: upload.status,
                expiresAt: upload.expiresAt,
              },
              error,
            );
            if (inactiveResponse) {
              return inactiveResponse;
            }

            let storedObject: { etag?: string; sizeBytes?: bigint };
            try {
              storedObject = await storeProxyUploadObject(
                resolvedConfig.storage,
                upload,
                context.bodyStream(),
              );
            } catch (cause) {
              const storageError =
                cause instanceof UploadServiceError ? cause : mapStorageOperationError(cause);
              await this.handlerTx()
                .withServiceCalls(() => [
                  services.markUploadFailed(
                    upload.id.toString(),
                    storageError.code,
                    storageError.message,
                  ),
                ])
                .execute();
              return handleUploadServiceError(storageError, error);
            }

            const completionOptions =
              storedObject.sizeBytes === undefined
                ? undefined
                : { sizeBytes: storedObject.sizeBytes };

            const completion = await this.handlerTx()
              .withServiceCalls(() => [
                services.completeUploadPublicationFromSnapshot(upload, completionOptions),
              ])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            if (completion.kind === "prepared") {
              return json(completion);
            }
            return json({ kind: "published", file: toFileMutationResult(completion.file) });
          } catch (err) {
            return handleUploadServiceError(err, error);
          }
        },
      }),
    ];
  },
);
