import { defineRoutes } from "@fragno-dev/core";
import type { FragnoRouteConfig } from "@fragno-dev/core";
import { z } from "zod";
import { uploadFragmentDefinition } from "../definition";
import { resolveUploadFragmentConfig } from "../config";
import { resolveFileKeyInput } from "../services/helpers";
import {
  checksumSchema,
  fileKeyPartsSchema,
  fileMetadataSchema,
  toFileMetadata,
  visibilitySchema,
} from "./shared";

const listQuerySchema = z.object({
  prefix: z.string().optional(),
  cursor: z.string().optional(),
  pageSize: z.coerce.number().min(1).max(100).catch(25),
  status: z.enum(["ready", "deleted"]).optional(),
  uploaderId: z.string().optional(),
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
    case "UPLOAD_NOT_FOUND":
      return error({ message: "Upload not found", code: "UPLOAD_NOT_FOUND" as Code }, 404);
    case "FILE_ALREADY_EXISTS":
      return error({ message: "File already exists", code: "FILE_ALREADY_EXISTS" as Code }, 409);
    case "UPLOAD_ALREADY_ACTIVE":
      return error(
        { message: "Upload already active", code: "UPLOAD_ALREADY_ACTIVE" as Code },
        409,
      );
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

export const fileRoutesFactory = defineRoutes(uploadFragmentDefinition).create(
  ({ services, defineRoute, config }) => {
    const getResolvedConfig = () => resolveUploadFragmentConfig(config);

    const parseListQuery = (query: URLSearchParams) => {
      const result = listQuerySchema.safeParse({
        prefix: query.get("prefix") || undefined,
        cursor: query.get("cursor") || undefined,
        pageSize: query.get("pageSize"),
        status: query.get("status") || undefined,
        uploaderId: query.get("uploaderId") || undefined,
      });
      if (!result.success) {
        throw new Error("INVALID_REQUEST");
      }
      const params = result.data;

      if (params.prefix && !params.prefix.endsWith(".")) {
        throw new Error("INVALID_FILE_KEY");
      }

      return params;
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

          let keyParts: z.infer<typeof fileKeyPartsSchema> | undefined;
          if (form.has("keyParts")) {
            const parsed = parseJson<unknown>(form.get("keyParts"));
            const result = fileKeyPartsSchema.safeParse(parsed);
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
            resolvedKey = resolveFileKeyInput({ keyParts, fileKey: fileKey ?? undefined });
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

          const createInput = {
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
            await this.handlerTx()
              .withServiceCalls(() => [
                services.checkUploadAvailability(createInput, { allowIdempotentReuse: false }),
              ])
              .execute();
          } catch (err) {
            return handleServiceError(err, error);
          }

          try {
            storageInit = await resolvedConfig.storage.initUpload({
              fileKey: resolvedKey.fileKey,
              fileKeyParts: resolvedKey.fileKeyParts,
              sizeBytes: BigInt(file.size),
              contentType,
              checksum: checksumForStorage,
              metadata: metadata ?? null,
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

          let created;
          try {
            created = await this.handlerTx()
              .withServiceCalls(() => [
                services.createUploadRecord({
                  ...createInput,
                  storageInit,
                  allowIdempotentReuse: false,
                }),
              ])
              .transform(({ serviceResult: [result] }) => result)
              .execute();
          } catch (err) {
            return handleServiceError(err, error);
          }

          const createdUpload = created.result;

          try {
            if (createdUpload.strategy === "proxy") {
              if (!resolvedConfig.storage.writeStream) {
                throw new Error("STORAGE_ERROR");
              }
              await resolvedConfig.storage.writeStream({
                storageKey: storageInit.storageKey,
                body: file.stream(),
                contentType,
                sizeBytes: BigInt(file.size),
              });
            } else if (createdUpload.strategy === "direct-single") {
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
              return error({ message: "Upload invalid state", code: "UPLOAD_INVALID_STATE" }, 409);
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
                services.markUploadFailed(
                  createdUpload.uploadId,
                  "STORAGE_ERROR",
                  "Storage upload failed",
                ),
              ])
              .execute();
            return error({ message: "Storage error", code: "STORAGE_ERROR" }, 502);
          }

          try {
            const completed = await this.handlerTx()
              .withServiceCalls(() => [
                services.markUploadComplete(createdUpload.uploadId, createdUpload.fileKey, {
                  sizeBytes: BigInt(file.size),
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
        queryParameters: ["prefix", "cursor", "pageSize", "status", "uploaderId"],
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
        path: "/files/:fileKey",
        outputSchema: fileMetadataSchema,
        errorCodes,
        handler: async function ({ pathParams }, { json, error }) {
          let resolvedKey;
          try {
            resolvedKey = resolveFileKeyInput({ fileKey: pathParams.fileKey });
          } catch (err) {
            return handleServiceError(err, error);
          }

          try {
            const file = await this.handlerTx()
              .withServiceCalls(() => [services.getFileByKey(resolvedKey.fileKey)])
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
        path: "/files/:fileKey",
        inputSchema: updateFileSchema,
        outputSchema: fileMetadataSchema,
        errorCodes,
        handler: async function ({ pathParams, input }, { json, error }) {
          const payload = await input.valid();
          let resolvedKey;
          try {
            resolvedKey = resolveFileKeyInput({ fileKey: pathParams.fileKey });
          } catch (err) {
            return handleServiceError(err, error);
          }

          try {
            const file = await this.handlerTx()
              .withServiceCalls(() => [services.updateFile(resolvedKey.fileKey, payload)])
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
        path: "/files/:fileKey",
        outputSchema: z.object({ ok: z.literal(true) }),
        errorCodes,
        handler: async function ({ pathParams }, { json, error }) {
          const resolvedConfig = getResolvedConfig();
          let resolvedKey;
          try {
            resolvedKey = resolveFileKeyInput({ fileKey: pathParams.fileKey });
          } catch (err) {
            return handleServiceError(err, error);
          }

          try {
            const file = await this.handlerTx()
              .withServiceCalls(() => [services.getFileByKey(resolvedKey.fileKey)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            try {
              await resolvedConfig.storage.deleteObject({ storageKey: file.storageKey });
            } catch {
              return error({ message: "Storage error", code: "STORAGE_ERROR" }, 502);
            }

            await this.handlerTx()
              .withServiceCalls(() => [
                services.markFileDeleted(resolvedKey.fileKey, resolvedKey.fileKeyParts),
              ])
              .execute();

            return json({ ok: true });
          } catch (err) {
            return handleServiceError(err, error);
          }
        },
      }),

      defineRoute({
        method: "GET",
        path: "/files/:fileKey/download-url",
        outputSchema: z.object({
          url: z.string(),
          headers: z.record(z.string(), z.string()).optional(),
          expiresAt: z.date(),
        }),
        errorCodes,
        handler: async function ({ pathParams }, { json, error }) {
          const resolvedConfig = getResolvedConfig();
          let resolvedKey;
          try {
            resolvedKey = resolveFileKeyInput({ fileKey: pathParams.fileKey });
          } catch (err) {
            return handleServiceError(err, error);
          }

          if (!resolvedConfig.storage.getDownloadUrl) {
            return error(
              { message: "Signed URLs are not supported", code: "SIGNED_URL_UNSUPPORTED" },
              400,
            );
          }

          try {
            const file = await this.handlerTx()
              .withServiceCalls(() => [services.getFileByKey(resolvedKey.fileKey)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            let result;
            try {
              result = await resolvedConfig.storage.getDownloadUrl({
                storageKey: file.storageKey,
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
        path: "/files/:fileKey/content",
        errorCodes,
        handler: async function ({ pathParams }, { error }) {
          const resolvedConfig = getResolvedConfig();
          let resolvedKey;
          try {
            resolvedKey = resolveFileKeyInput({ fileKey: pathParams.fileKey });
          } catch (err) {
            return handleServiceError(err, error);
          }

          if (!resolvedConfig.storage.getDownloadStream) {
            return error(
              { message: "Download streaming unsupported", code: "SIGNED_URL_UNSUPPORTED" },
              400,
            );
          }

          try {
            const file = await this.handlerTx()
              .withServiceCalls(() => [services.getFileByKey(resolvedKey.fileKey)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            try {
              return await resolvedConfig.storage.getDownloadStream({
                storageKey: file.storageKey,
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
