import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";
import type { FragnoRouteConfig } from "@fragno-dev/core";

import { resolveUploadFragmentConfig } from "../config";
import { uploadFragmentDefinition } from "../definition";
import { resolveFileKeyInput } from "../services/helpers";
import { buildStorageObjectVersionSegment } from "../storage/object-key";
import {
  checksumSchema,
  fileMetadataSchema,
  providerNamespaceSchema,
  toFileMetadata,
  visibilitySchema,
} from "./shared";

const legacyFileKeyPartsSchema = z.array(z.union([z.string(), z.number().int()]));

const listQuerySchema = z.object({
  provider: providerNamespaceSchema.optional(),
  prefix: z.string().optional(),
  cursor: z.string().optional(),
  pageSize: z.coerce.number().min(1).max(100).catch(25),
  status: z.enum(["ready", "deleted"]).optional(),
  uploaderId: z.string().optional(),
});

const byKeyQuerySchema = z.object({
  provider: providerNamespaceSchema,
  key: z.string().min(1),
});

const updateFileSchema = z.object({
  filename: z.string().min(1).optional(),
  visibility: visibilitySchema.optional(),
  tags: z.array(z.string()).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

const errorCodes = [
  "UPLOAD_NOT_FOUND",
  "UPLOAD_ALREADY_ACTIVE",
  "FILE_ALREADY_EXISTS",
  "FILE_NOT_FOUND",
  "FILE_DELETED",
  "UPLOAD_EXPIRED",
  "UPLOAD_INVALID_STATE",
  "SIGNED_URL_UNSUPPORTED",
  "STORAGE_ERROR",
  "INVALID_FILE_KEY",
  "INVALID_CHECKSUM",
  "INVALID_REQUEST",
] as const;

type FileErrorCode = (typeof errorCodes)[number];

type ErrorFn<Code extends string> = Parameters<
  FragnoRouteConfig<"GET", "/__error", undefined, undefined, Code>["handler"]
>[1]["error"];

const handleServiceError = <Code extends FileErrorCode>(
  err: unknown,
  error: ErrorFn<Code>,
): Response => {
  if (!(err instanceof Error)) {
    throw err;
  }

  switch (err.message) {
    case "FILE_NOT_FOUND":
      return error({ message: "File not found", code: "FILE_NOT_FOUND" as Code }, 404);
    case "FILE_DELETED":
      return error({ message: "File deleted", code: "FILE_DELETED" as Code }, 410);
    case "UPLOAD_NOT_FOUND":
      return error({ message: "Upload not found", code: "UPLOAD_NOT_FOUND" as Code }, 404);
    case "FILE_ALREADY_EXISTS":
      return error({ message: "File already exists", code: "FILE_ALREADY_EXISTS" as Code }, 409);
    case "UPLOAD_ALREADY_ACTIVE":
      return error(
        {
          message: "Upload already active",
          code: "UPLOAD_ALREADY_ACTIVE" as Code,
        },
        409,
      );
    case "UPLOAD_EXPIRED":
      return error({ message: "Upload expired", code: "UPLOAD_EXPIRED" as Code }, 410);
    case "UPLOAD_INVALID_STATE":
      return error(
        {
          message: "Upload invalid state",
          code: "UPLOAD_INVALID_STATE" as Code,
        },
        409,
      );
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

const parseJson = <T>(value: FormDataEntryValue | null): T | undefined => {
  if (value === null || typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
};

const parseTags = (value: FormDataEntryValue | null): string[] | undefined => {
  if (value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = parseJson<unknown>(value);
  if (Array.isArray(parsed)) {
    return parsed.filter((tag) => typeof tag === "string") as string[];
  }
  if (typeof value === "string" && value.length > 0) {
    return [value];
  }
  return undefined;
};

const parseMetadata = (value: FormDataEntryValue | null): Record<string, unknown> | undefined => {
  const parsed = parseJson<unknown>(value);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return undefined;
};

const assertFileAvailable = <T extends { status: string }>(file: T) => {
  if (file.status === "deleted") {
    throw new Error("FILE_DELETED");
  }
  return file;
};

export const fileRoutesFactory = defineRoutes(uploadFragmentDefinition).create(
  ({ services, defineRoute, config }) => {
    const getResolvedConfig = () => resolveUploadFragmentConfig(config);

    const parseListQuery = (query: URLSearchParams) => {
      const result = listQuerySchema.safeParse({
        provider: query.has("provider") ? query.get("provider") : undefined,
        prefix: query.get("prefix") || undefined,
        cursor: query.get("cursor") || undefined,
        pageSize: query.get("pageSize"),
        status: query.get("status") || undefined,
        uploaderId: query.get("uploaderId") || undefined,
      });
      if (!result.success) {
        throw new Error("INVALID_REQUEST");
      }
      return result.data;
    };

    const parseByKeyQuery = (query: URLSearchParams) => {
      const result = byKeyQuerySchema.safeParse({
        provider: query.get("provider"),
        key: query.get("key"),
      });
      if (!result.success) {
        throw new Error("INVALID_REQUEST");
      }

      try {
        const resolvedKey = resolveFileKeyInput({ fileKey: result.data.key });
        return {
          provider: result.data.provider,
          fileKey: resolvedKey.fileKey,
        };
      } catch {
        throw new Error("INVALID_FILE_KEY");
      }
    };

    return [
      defineRoute({
        method: "POST",
        path: "/files",
        contentType: "multipart/form-data",
        outputSchema: fileMetadataSchema,
        errorCodes,
        handler: async function (context, { json, error }) {
          const resolvedConfig = getResolvedConfig();
          const form = context.formData();
          const file = form.get("file");
          if (!(file instanceof Blob)) {
            return error({ message: "File is required", code: "INVALID_REQUEST" }, 400);
          }

          const providerValue = form.get("provider");
          const providerResult = providerNamespaceSchema.safeParse(providerValue);
          if (!providerResult.success) {
            return error({ message: "Invalid request", code: "INVALID_REQUEST" }, 400);
          }
          const provider = providerResult.data;

          let keyParts: z.infer<typeof legacyFileKeyPartsSchema> | undefined;
          if (form.has("keyParts")) {
            const parsed = parseJson<unknown>(form.get("keyParts"));
            const result = legacyFileKeyPartsSchema.safeParse(parsed);
            if (!result.success) {
              return error({ message: "Invalid file key", code: "INVALID_FILE_KEY" }, 400);
            }
            keyParts = result.data;
          }

          const fileKeyValue = form.get("fileKey");
          const fileKey = typeof fileKeyValue === "string" ? fileKeyValue : undefined;

          const checksumValue = form.get("checksum");
          const parsedChecksum = parseJson<unknown>(checksumValue);
          const checksumResult = checksumSchema.safeParse(parsedChecksum);
          if (!checksumResult.success) {
            return error({ message: "Invalid checksum", code: "INVALID_CHECKSUM" }, 400);
          }

          const tags = parseTags(form.get("tags"));
          const metadata = parseMetadata(form.get("metadata"));

          let resolvedKey;
          try {
            resolvedKey = resolveFileKeyInput({
              keyParts,
              fileKey: fileKey ?? undefined,
            });
          } catch (err) {
            return handleServiceError(err, error);
          }

          const checksumForStorage = checksumResult.data ?? null;
          const checksumForRecord = checksumResult.data ?? undefined;

          let storageInit;

          const uploaderIdValue = form.get("uploaderId");
          const uploaderId = typeof uploaderIdValue === "string" ? uploaderIdValue : undefined;
          const visibilityValue = form.get("visibility");
          const parsedVisibility =
            typeof visibilityValue === "string" ? visibilityValue : undefined;
          const visibilityResult = visibilitySchema.optional().safeParse(parsedVisibility);
          if (!visibilityResult.success) {
            return error({ message: "Invalid request", code: "INVALID_REQUEST" }, 400);
          }
          const visibility = visibilityResult.data;
          const filenameValue = form.get("filename");
          const filename =
            typeof filenameValue === "string" && filenameValue
              ? filenameValue
              : file instanceof File && file.name
                ? file.name
                : "upload";
          const contentType = file.type || "application/octet-stream";

          const objectKeyVersionSegment = buildStorageObjectVersionSegment();

          const createInput = {
            provider,
            fileKey: resolvedKey.fileKey,
            keyParts: resolvedKey.fileKeyParts,
            filename,
            sizeBytes: file.size,
            contentType,
            checksum: checksumForRecord,
            tags,
            visibility,
            uploaderId,
            metadata,
          };

          try {
            storageInit = await resolvedConfig.storage.initUpload({
              provider,
              fileKey: resolvedKey.fileKey,
              sizeBytes: BigInt(file.size),
              contentType,
              checksum: checksumForStorage,
              metadata: metadata ?? null,
              objectKeyVersionSegment,
            });
          } catch {
            return error({ message: "Storage error", code: "STORAGE_ERROR" }, 502);
          }

          if (storageInit.strategy === "direct-multipart") {
            if (resolvedConfig.storage.abortMultipartUpload && storageInit.storageUploadId) {
              try {
                await resolvedConfig.storage.abortMultipartUpload({
                  storageKey: storageInit.storageKey,
                  storageUploadId: storageInit.storageUploadId,
                });
              } catch {
                // Ignore abort failures; the request is still invalid for this endpoint.
              }
            }

            return error({ message: "Upload invalid state", code: "UPLOAD_INVALID_STATE" }, 409);
          }

          try {
            if (storageInit.strategy === "proxy") {
              if (!resolvedConfig.storage.writeStream) {
                throw new Error("STORAGE_ERROR");
              }
              await resolvedConfig.storage.writeStream({
                storageKey: storageInit.storageKey,
                body: file.stream(),
                contentType,
                sizeBytes: BigInt(file.size),
              });
            } else if (storageInit.strategy === "direct-single") {
              if (!storageInit.uploadUrl) {
                throw new Error("STORAGE_ERROR");
              }
              const response = await fetch(storageInit.uploadUrl, {
                method: "PUT",
                headers: storageInit.uploadHeaders,
                body: file,
              });
              if (!response.ok) {
                throw new Error("STORAGE_ERROR");
              }
            } else {
              return error(
                {
                  message: "Upload invalid state",
                  code: "UPLOAD_INVALID_STATE",
                },
                409,
              );
            }

            if (resolvedConfig.storage.finalizeUpload) {
              await resolvedConfig.storage.finalizeUpload({
                storageKey: storageInit.storageKey,
                expectedSizeBytes: BigInt(file.size),
                checksum: checksumResult.data ?? null,
              });
            }
          } catch {
            await this.handlerTx()
              .withServiceCalls(() => [
                services.createFailedUpload({
                  ...createInput,
                  storageInit,
                  errorCode: "STORAGE_ERROR",
                  errorMessage: "Storage upload failed",
                }),
              ])
              .execute();
            return error({ message: "Storage error", code: "STORAGE_ERROR" }, 502);
          }

          try {
            const completed = await this.handlerTx()
              .withServiceCalls(() => [
                services.createCompletedUpload({
                  ...createInput,
                  storageInit,
                  completedSizeBytes: BigInt(file.size),
                }),
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
        method: "GET",
        path: "/files",
        queryParameters: ["provider", "prefix", "cursor", "pageSize", "status", "uploaderId"],
        outputSchema: z.object({
          files: z.array(fileMetadataSchema),
          cursor: z.string().optional(),
          hasNextPage: z.boolean(),
        }),
        errorCodes,
        handler: async function ({ query }, { json, error }) {
          let params;
          try {
            params = parseListQuery(query);
          } catch (err) {
            return handleServiceError(err, error);
          }

          const result = await this.handlerTx()
            .withServiceCalls(() => [
              services.listFiles({
                provider: params.provider,
                prefix: params.prefix,
                pageSize: params.pageSize,
                cursor: params.cursor,
                status: params.status,
                uploaderId: params.uploaderId,
              }),
            ])
            .transform(({ serviceResult: [files] }) => files)
            .execute();

          return json({
            files: result.items.map(toFileMetadata),
            cursor: result.cursor?.encode(),
            hasNextPage: result.hasNextPage,
          });
        },
      }),

      defineRoute({
        method: "GET",
        path: "/files/by-key",
        queryParameters: ["provider", "key"],
        outputSchema: fileMetadataSchema,
        errorCodes,
        handler: async function ({ query }, { json, error }) {
          let byKey;
          try {
            byKey = parseByKeyQuery(query);
          } catch (err) {
            return handleServiceError(err, error);
          }

          try {
            const file = await this.handlerTx()
              .withServiceCalls(() => [services.getFileByKey(byKey)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            return json(toFileMetadata(file));
          } catch (err) {
            return handleServiceError(err, error);
          }
        },
      }),

      defineRoute({
        method: "PATCH",
        path: "/files/by-key",
        queryParameters: ["provider", "key"],
        inputSchema: updateFileSchema,
        outputSchema: fileMetadataSchema,
        errorCodes,
        handler: async function ({ query, input }, { json, error }) {
          const payload = await input.valid();
          let byKey;
          try {
            byKey = parseByKeyQuery(query);
          } catch (err) {
            return handleServiceError(err, error);
          }

          try {
            const file = await this.handlerTx()
              .withServiceCalls(() => [services.updateFile(byKey, payload)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            return json(toFileMetadata(file));
          } catch (err) {
            return handleServiceError(err, error);
          }
        },
      }),

      defineRoute({
        method: "DELETE",
        path: "/files/by-key",
        queryParameters: ["provider", "key"],
        outputSchema: z.object({ ok: z.literal(true) }),
        errorCodes,
        handler: async function ({ query }, { json, error }) {
          let byKey;
          try {
            byKey = parseByKeyQuery(query);
          } catch (err) {
            return handleServiceError(err, error);
          }

          try {
            await this.handlerTx()
              .withServiceCalls(() => [services.markFileDeleted(byKey)])
              .execute();

            return json({ ok: true });
          } catch (err) {
            return handleServiceError(err, error);
          }
        },
      }),

      defineRoute({
        method: "GET",
        path: "/files/by-key/download-url",
        queryParameters: ["provider", "key"],
        outputSchema: z.object({
          url: z.string(),
          headers: z.record(z.string(), z.string()).optional(),
          expiresAt: z.date(),
        }),
        errorCodes,
        handler: async function ({ query }, { json, error }) {
          const resolvedConfig = getResolvedConfig();
          let byKey;
          try {
            byKey = parseByKeyQuery(query);
          } catch (err) {
            return handleServiceError(err, error);
          }

          if (!resolvedConfig.storage.getDownloadUrl) {
            return error(
              {
                message: "Signed URLs are not supported",
                code: "SIGNED_URL_UNSUPPORTED",
              },
              400,
            );
          }

          try {
            const file = assertFileAvailable(
              await this.handlerTx()
                .withServiceCalls(() => [services.getFileByKey(byKey)])
                .transform(({ serviceResult: [result] }) => result)
                .execute(),
            );

            let result;
            try {
              result = await resolvedConfig.storage.getDownloadUrl({
                storageKey: file.objectKey,
                expiresInSeconds: resolvedConfig.signedUrlExpiresInSeconds,
                contentType: file.contentType ?? undefined,
              });
            } catch {
              return error({ message: "Storage error", code: "STORAGE_ERROR" }, 502);
            }

            return json(result);
          } catch (err) {
            return handleServiceError(err, error);
          }
        },
      }),

      defineRoute({
        method: "GET",
        path: "/files/by-key/content",
        queryParameters: ["provider", "key"],
        errorCodes,
        handler: async function ({ query }, { error }) {
          const resolvedConfig = getResolvedConfig();
          let byKey;
          try {
            byKey = parseByKeyQuery(query);
          } catch (err) {
            return handleServiceError(err, error);
          }

          if (!resolvedConfig.storage.getDownloadStream) {
            return error(
              {
                message: "Download streaming unsupported",
                code: "SIGNED_URL_UNSUPPORTED",
              },
              400,
            );
          }

          try {
            const file = assertFileAvailable(
              await this.handlerTx()
                .withServiceCalls(() => [services.getFileByKey(byKey)])
                .transform(({ serviceResult: [result] }) => result)
                .execute(),
            );

            try {
              return await resolvedConfig.storage.getDownloadStream({
                storageKey: file.objectKey,
              });
            } catch {
              return error({ message: "Storage error", code: "STORAGE_ERROR" }, 502);
            }
          } catch (err) {
            return handleServiceError(err, error);
          }
        },
      }),
    ];
  },
);
