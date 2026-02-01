import { defineRoutes } from "@fragno-dev/core";
import type { FragnoRouteConfig } from "@fragno-dev/core";
import { z } from "zod";
import { resolveUploadFragmentConfig } from "../config";
import { uploadFragmentDefinition } from "../definition";
import { resolveFileKeyInput } from "../services/helpers";
import { checksumSchema, fileKeyPartsSchema, fileMetadataSchema, toFileMetadata } from "./shared";
import type { UploadStatus, UploadStrategy } from "../types";
import type { UploadChecksum } from "../storage/types";

const uploadStrategySchema = z.enum(["direct-single", "direct-multipart", "proxy"]);

const createUploadInputSchema = z.object({
  keyParts: fileKeyPartsSchema.optional(),
  fileKey: z.string().optional(),
  filename: z.string().min(1),
  sizeBytes: z.number().int().min(0),
  contentType: z.string().min(1),
  checksum: checksumSchema.optional(),
  tags: z.array(z.string()).optional(),
  visibility: z.enum(["private", "public", "unlisted"]).optional(),
  uploaderId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const progressSchema = z.object({
  bytesUploaded: z.number().int().min(0).optional(),
  partsUploaded: z.number().int().min(0).optional(),
});

const partNumbersSchema = z.object({
  partNumbers: z.array(z.number().int().min(1)).min(1),
});

const completePartsSchema = z.object({
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().min(1),
        etag: z.string().min(1),
        sizeBytes: z.number().int().min(0),
      }),
    )
    .min(1),
});

const completeUploadSchema = z.object({
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().min(1),
        etag: z.string().min(1),
      }),
    )
    .optional(),
});

const uploadStatusSchema = z.object({
  uploadId: z.string(),
  fileKey: z.string(),
  status: z.enum(["created", "in_progress", "completed", "aborted", "failed", "expired"]),
  strategy: uploadStrategySchema,
  expectedSizeBytes: z.number(),
  bytesUploaded: z.number(),
  partsUploaded: z.number(),
  partSizeBytes: z.number().nullable(),
  expiresAt: z.date(),
  createdAt: z.date(),
  updatedAt: z.date(),
  completedAt: z.date().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
});

const errorCodes = [
  "UPLOAD_NOT_FOUND",
  "FILE_NOT_FOUND",
  "UPLOAD_EXPIRED",
  "UPLOAD_INVALID_STATE",
  "INVALID_FILE_KEY",
  "INVALID_CHECKSUM",
  "INVALID_REQUEST",
  "STORAGE_ERROR",
] as const;

type UploadErrorCode = (typeof errorCodes)[number];

type ErrorFn<Code extends string> = Parameters<
  FragnoRouteConfig<"GET", "/__error", undefined, undefined, Code>["handler"]
>[1]["error"];

const handleServiceError = <Code extends UploadErrorCode>(
  err: unknown,
  error: ErrorFn<Code>,
): Response => {
  if (!(err instanceof Error)) {
    throw err;
  }

  switch (err.message) {
    case "UPLOAD_NOT_FOUND":
      return error({ message: "Upload not found", code: "UPLOAD_NOT_FOUND" as Code }, 404);
    case "FILE_NOT_FOUND":
      return error({ message: "File not found", code: "FILE_NOT_FOUND" as Code }, 404);
    case "UPLOAD_EXPIRED":
      return error({ message: "Upload expired", code: "UPLOAD_EXPIRED" as Code }, 410);
    case "UPLOAD_INVALID_STATE":
      return error({ message: "Upload invalid state", code: "UPLOAD_INVALID_STATE" as Code }, 409);
    case "INVALID_FILE_KEY":
      return error({ message: "Invalid file key", code: "INVALID_FILE_KEY" as Code }, 400);
    case "INVALID_CHECKSUM":
      return error({ message: "Invalid checksum", code: "INVALID_CHECKSUM" as Code }, 400);
    case "INVALID_REQUEST":
      return error({ message: "Invalid request", code: "INVALID_REQUEST" as Code }, 400);
    case "STORAGE_ERROR":
      return error({ message: "Storage error", code: "STORAGE_ERROR" as Code }, 502);
    default:
      throw err;
  }
};

export const uploadRoutesFactory = defineRoutes(uploadFragmentDefinition).create(
  ({ services, defineRoute, config }) => {
    const getResolvedConfig = () => resolveUploadFragmentConfig(config);

    return [
      defineRoute({
        method: "POST",
        path: "/uploads",
        inputSchema: createUploadInputSchema,
        outputSchema: z.object({
          uploadId: z.string(),
          fileKey: z.string(),
          status: z.literal("created"),
          strategy: uploadStrategySchema,
          expiresAt: z.date(),
          upload: z.object({
            mode: z.enum(["single", "multipart"]),
            transport: z.enum(["direct", "proxy"]),
            uploadUrl: z.string().optional(),
            uploadHeaders: z.record(z.string(), z.string()).optional(),
            partSizeBytes: z.number().optional(),
            maxParts: z.number().optional(),
            partsEndpoint: z.string().optional(),
            completeEndpoint: z.string(),
            contentEndpoint: z.string().optional(),
          }),
        }),
        errorCodes,
        handler: async function ({ input }, { json, error }) {
          const payload = await input.valid();
          const resolvedConfig = getResolvedConfig();

          let resolvedKey;
          try {
            resolvedKey = resolveFileKeyInput({
              keyParts: payload.keyParts,
              fileKey: payload.fileKey,
            });
          } catch (err) {
            return handleServiceError(err, error);
          }

          let storageInit;
          try {
            storageInit = await resolvedConfig.storage.initUpload({
              fileKey: resolvedKey.fileKey,
              fileKeyParts: resolvedKey.fileKeyParts,
              sizeBytes: BigInt(payload.sizeBytes),
              contentType: payload.contentType,
              checksum: payload.checksum ?? null,
              metadata: payload.metadata ?? null,
            });
          } catch {
            return error({ message: "Storage error", code: "STORAGE_ERROR" }, 502);
          }

          try {
            const result = await this.handlerTx()
              .withServiceCalls(() => [
                services.createUploadRecord({
                  ...payload,
                  storageInit,
                }),
              ])
              .transform(({ serviceResult: [created] }) => created)
              .execute();

            return json(result);
          } catch (err) {
            return handleServiceError(err, error);
          }
        },
      }),

      defineRoute({
        method: "GET",
        path: "/uploads/:uploadId",
        outputSchema: uploadStatusSchema,
        errorCodes,
        handler: async function ({ pathParams }, { json, error }) {
          try {
            const upload = await this.handlerTx()
              .withServiceCalls(() => [services.getUploadStatus(pathParams.uploadId)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            return json({
              uploadId: upload.id.toString(),
              fileKey: upload.fileKey,
              status: upload.status as UploadStatus,
              strategy: upload.strategy as UploadStrategy,
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
            return handleServiceError(err, error);
          }
        },
      }),

      defineRoute({
        method: "POST",
        path: "/uploads/:uploadId/progress",
        inputSchema: progressSchema,
        outputSchema: z.object({
          bytesUploaded: z.number(),
          partsUploaded: z.number(),
        }),
        errorCodes,
        handler: async function ({ pathParams, input }, { json, error }) {
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
            return handleServiceError(err, error);
          }
        },
      }),

      defineRoute({
        method: "POST",
        path: "/uploads/:uploadId/parts",
        inputSchema: partNumbersSchema,
        outputSchema: z.object({
          parts: z.array(
            z.object({
              partNumber: z.number(),
              url: z.string(),
              headers: z.record(z.string(), z.string()).optional(),
            }),
          ),
        }),
        errorCodes,
        handler: async function ({ pathParams, input }, { json, error }) {
          const payload = await input.valid();
          const resolvedConfig = getResolvedConfig();
          try {
            const upload = await this.handlerTx()
              .withServiceCalls(() => [services.getUploadStorageInfo(pathParams.uploadId)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            if (upload.strategy !== "direct-multipart") {
              return error({ message: "Upload invalid state", code: "UPLOAD_INVALID_STATE" }, 409);
            }

            const file = await this.handlerTx()
              .withServiceCalls(() => [services.getFileByKey(upload.fileKey)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            if (!resolvedConfig.storage.getPartUploadUrls) {
              return error({ message: "Storage error", code: "STORAGE_ERROR" }, 502);
            }

            const parts = await resolvedConfig.storage.getPartUploadUrls({
              storageKey: file.storageKey,
              storageUploadId: upload.storageUploadId ?? "",
              partNumbers: payload.partNumbers,
              partSizeBytes: upload.partSizeBytes ?? 0,
            });

            return json({ parts });
          } catch (err) {
            return handleServiceError(err, error);
          }
        },
      }),

      defineRoute({
        method: "GET",
        path: "/uploads/:uploadId/parts",
        outputSchema: z.object({
          parts: z.array(
            z.object({
              partNumber: z.number(),
              etag: z.string(),
              sizeBytes: z.number(),
              createdAt: z.date(),
            }),
          ),
        }),
        errorCodes,
        handler: async function ({ pathParams }, { json, error }) {
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
            return handleServiceError(err, error);
          }
        },
      }),

      defineRoute({
        method: "POST",
        path: "/uploads/:uploadId/parts/complete",
        inputSchema: completePartsSchema,
        outputSchema: z.object({
          bytesUploaded: z.number(),
          partsUploaded: z.number(),
        }),
        errorCodes,
        handler: async function ({ pathParams, input }, { json, error }) {
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
            return handleServiceError(err, error);
          }
        },
      }),

      defineRoute({
        method: "POST",
        path: "/uploads/:uploadId/complete",
        inputSchema: completeUploadSchema,
        outputSchema: fileMetadataSchema,
        errorCodes,
        handler: async function ({ pathParams, input }, { json, error }) {
          const payload = await input.valid();
          const resolvedConfig = getResolvedConfig();
          try {
            const upload = await this.handlerTx()
              .withServiceCalls(() => [services.getUploadStorageInfo(pathParams.uploadId)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            const file = await this.handlerTx()
              .withServiceCalls(() => [services.getFileByKey(upload.fileKey)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            let finalizeResult: { sizeBytes?: bigint } | undefined;

            if (upload.strategy === "direct-multipart") {
              if (!resolvedConfig.storage.completeMultipartUpload) {
                return error({ message: "Storage error", code: "STORAGE_ERROR" }, 502);
              }

              if (!payload.parts || payload.parts.length === 0) {
                return error(
                  { message: "Upload invalid state", code: "UPLOAD_INVALID_STATE" },
                  409,
                );
              }

              await resolvedConfig.storage.completeMultipartUpload({
                storageKey: file.storageKey,
                storageUploadId: upload.storageUploadId ?? "",
                parts: payload.parts,
              });
            } else if (resolvedConfig.storage.finalizeUpload) {
              finalizeResult = await resolvedConfig.storage.finalizeUpload({
                storageKey: file.storageKey,
                expectedSizeBytes: file.sizeBytes,
                checksum: file.checksum as UploadChecksum | null,
              });
            }

            const completed = await this.handlerTx()
              .withServiceCalls(() => [
                services.markUploadComplete(
                  upload.id.toString(),
                  file.fileKey,
                  finalizeResult?.sizeBytes ? { sizeBytes: finalizeResult.sizeBytes } : undefined,
                ),
              ])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            return json(toFileMetadata(completed.file));
          } catch (err) {
            return handleServiceError(err, error);
          }
        },
      }),

      defineRoute({
        method: "POST",
        path: "/uploads/:uploadId/abort",
        outputSchema: z.object({ ok: z.literal(true) }),
        errorCodes,
        handler: async function ({ pathParams }, { json, error }) {
          const resolvedConfig = getResolvedConfig();
          try {
            const upload = await this.handlerTx()
              .withServiceCalls(() => [services.getUploadStorageInfo(pathParams.uploadId)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            if (
              upload.strategy === "direct-multipart" &&
              resolvedConfig.storage.abortMultipartUpload
            ) {
              await resolvedConfig.storage.abortMultipartUpload({
                storageKey: resolvedConfig.storage.resolveStorageKey({
                  fileKey: upload.fileKey,
                  fileKeyParts: resolveFileKeyInput({ fileKey: upload.fileKey }).fileKeyParts,
                }),
                storageUploadId: upload.storageUploadId ?? "",
              });
            }

            await this.handlerTx()
              .withServiceCalls(() => [
                services.markUploadAborted(upload.id.toString(), upload.fileKey),
              ])
              .execute();

            return json({ ok: true });
          } catch (err) {
            return handleServiceError(err, error);
          }
        },
      }),

      defineRoute({
        method: "PUT",
        path: "/uploads/:uploadId/content",
        contentType: "application/octet-stream",
        outputSchema: fileMetadataSchema,
        errorCodes,
        handler: async function (context, { json, error }) {
          const { pathParams } = context;
          const resolvedConfig = getResolvedConfig();
          try {
            const upload = await this.handlerTx()
              .withServiceCalls(() => [services.getUploadStorageInfo(pathParams.uploadId)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            if (upload.strategy !== "proxy") {
              return error({ message: "Upload invalid state", code: "UPLOAD_INVALID_STATE" }, 409);
            }

            const file = await this.handlerTx()
              .withServiceCalls(() => [services.getFileByKey(upload.fileKey)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            if (!resolvedConfig.storage.writeStream) {
              return error({ message: "Storage error", code: "STORAGE_ERROR" }, 502);
            }

            let result: Awaited<ReturnType<NonNullable<typeof resolvedConfig.storage.writeStream>>>;
            try {
              result = await resolvedConfig.storage.writeStream({
                storageKey: file.storageKey,
                body: context.bodyStream(),
                contentType: file.contentType,
                sizeBytes: file.sizeBytes,
              });
            } catch {
              await this.handlerTx()
                .withServiceCalls(() => [
                  services.markUploadFailed(
                    upload.id.toString(),
                    file.fileKey,
                    "STORAGE_ERROR",
                    "Storage upload failed",
                  ),
                ])
                .execute();
              return error({ message: "Storage error", code: "STORAGE_ERROR" }, 502);
            }

            const completed = await this.handlerTx()
              .withServiceCalls(() => [
                services.markUploadComplete(
                  upload.id.toString(),
                  file.fileKey,
                  result?.sizeBytes ? { sizeBytes: result.sizeBytes } : undefined,
                ),
              ])
              .transform(({ serviceResult: [done] }) => done)
              .execute();

            return json(toFileMetadata(completed.file));
          } catch (err) {
            return handleServiceError(err, error);
          }
        },
      }),
    ];
  },
);
