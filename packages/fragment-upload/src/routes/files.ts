import type { TableToColumnValues } from "@fragno-dev/db/query";
import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import { resolveUploadFragmentConfig } from "../config";
import { uploadFragmentDefinition } from "../definition";
import {
  applyFileEditOperation,
  diffContent,
  FileEditError,
  type FileEditOperation,
} from "../file-edits";
import { uploadSchema } from "../schema";
import { UploadServiceError } from "../services/errors";
import { resolveFileKeyInput } from "../services/helpers";
import { MAX_PREPARED_FILE_BATCH_ENTRIES } from "../services/uploads";
import { buildStorageObjectVersionSegment } from "../storage/object-key";
import {
  extractTextIndexTerms,
  getStaticGlobPrefix,
  globToRegExp,
  searchTextContent,
} from "../text-index";
import type { PreparedFileBatchEntry } from "../types";
import {
  checksumSchema,
  fileMetadataSchema,
  fileMutationResultSchema,
  fileMutationSnapshotSchema,
  fileSnapshotSchema,
  fileWritePreconditionSchema,
  providerNamespaceSchema,
  toFileMetadata,
  toFileMutationResult,
  visibilitySchema,
} from "./shared";
import { handleUploadServiceError as handleServiceError } from "./uploads-errors";
import { mapStorageOperationError } from "./uploads-storage";

const legacyFileKeyPartsSchema = z.array(z.union([z.string(), z.number().int()]));

const listQuerySchema = z
  .object({
    provider: providerNamespaceSchema.optional(),
    prefix: z.string().optional(),
    glob: z.string().min(1).max(512).optional(),
    cursor: z.string().optional(),
    pageSize: z.coerce.number().min(1).max(500).optional().default(25),
    status: z.enum(["ready", "deleted"]).optional(),
    uploaderId: z.string().optional(),
    delimiter: z.literal("/").optional(),
  })
  .refine((value) => !(value.prefix && value.glob), {
    message: "prefix and glob cannot be combined",
  });

const directoryMetadataSchema = z.object({
  name: z.string(),
  prefix: z.string(),
  updatedAt: z.string().nullable(),
  contentType: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});

const byKeyQuerySchema = z.object({
  provider: providerNamespaceSchema,
  key: z.string().min(1),
});

const preparedFileBatchEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("write"),
    uploadId: z.string().min(1),
    precondition: fileWritePreconditionSchema.optional(),
  }),
  z.object({
    kind: z.literal("delete"),
    provider: providerNamespaceSchema,
    fileKey: z.string().min(1),
    precondition: z.object({
      kind: z.literal("revision"),
      revision: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    kind: z.literal("assert"),
    provider: providerNamespaceSchema,
    fileKey: z.string().min(1),
    precondition: fileWritePreconditionSchema,
  }),
]);

const commitPreparedFilesSchema = z.object({
  entries: z.array(preparedFileBatchEntrySchema).min(1).max(MAX_PREPARED_FILE_BATCH_ENTRIES),
});

const MAX_FILE_EDIT_OPERATIONS = 10;
const MAX_FILE_EDIT_FILES = 10;
const MAX_FILE_EDIT_TEXT_BYTES = 10 * 1024 * 1024;
const MAX_FILE_EDIT_PATTERN_LENGTH = 16 * 1024;
const FILE_EDIT_STORAGE_CONCURRENCY = 4;

const fileEditSearchOptionsSchema = z.object({
  caseSensitive: z.boolean().optional(),
  regex: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  maxMatches: z.number().int().min(1).max(10_000).optional(),
});

const fileEditOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("write"),
    fileKey: z.string().min(1),
    content: z.string().max(MAX_FILE_EDIT_TEXT_BYTES),
  }),
  z.object({
    kind: z.literal("replace"),
    fileKey: z.string().min(1),
    search: z.string().max(MAX_FILE_EDIT_PATTERN_LENGTH),
    replacement: z.string().max(MAX_FILE_EDIT_TEXT_BYTES),
    options: fileEditSearchOptionsSchema.optional(),
  }),
  z.object({
    kind: z.literal("writeJson"),
    fileKey: z.string().min(1),
    value: z.unknown(),
    options: z.object({ spaces: z.number().int().min(0).max(10).optional() }).optional(),
  }),
]);

const applyFileEditsSchema = z.object({
  provider: providerNamespaceSchema,
  edits: z.array(fileEditOperationSchema).min(1).max(MAX_FILE_EDIT_OPERATIONS),
});

const appliedFileEditSchema = z.object({
  fileKey: z.string(),
  changed: z.boolean(),
  content: z.string(),
  diff: z.string(),
});

const applyFileEditsResultSchema = z.object({
  edits: z.array(appliedFileEditSchema),
  totalChanged: z.number().int().nonnegative(),
});

type FileRow = TableToColumnValues<typeof uploadSchema.tables.file>;

type EvaluatedFile = {
  fileKey: string;
  original: FileRow | null;
  content: string;
  contentType: string;
  filename: string;
};

const mapWithConcurrency = async <Input, Output>(
  values: readonly Input[],
  concurrency: number,
  operation: (value: Input) => Promise<Output>,
): Promise<Output[]> => {
  const results = Array.from<Output>({ length: values.length });
  let nextIndex = 0;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (failure === undefined) {
        const index = nextIndex++;
        if (index >= values.length) {
          return;
        }
        try {
          results[index] = await operation(values[index]);
        } catch (cause) {
          failure = cause;
        }
      }
    }),
  );
  if (failure !== undefined) {
    throw failure instanceof Error ? failure : new Error(String(failure));
  }
  return results;
};

const updateFileSchema = z.object({
  filename: z.string().min(1).optional(),
  visibility: visibilitySchema.optional(),
  tags: z.array(z.string()).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

const stateSearchOptionsSchema = z.object({
  caseSensitive: z.boolean().optional(),
  regex: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  contextBefore: z.number().int().min(0).max(200).optional(),
  contextAfter: z.number().int().min(0).max(200).optional(),
  maxMatches: z.number().int().min(1).max(100).optional(),
});

const searchFilesSchema = z.object({
  provider: providerNamespaceSchema,
  glob: z.string().min(1).max(512),
  query: z.string().min(1).max(512),
  options: stateSearchOptionsSchema.optional(),
  maxCandidateFiles: z.number().int().min(1).max(500).optional(),
  cursor: z.string().optional(),
});

const searchFileCandidateSchema = z.object({
  key: z.string(),
  positions: z.array(z.number()),
  count: z.number(),
});

const MAX_SEARCH_HYDRATION_BYTES = 30 * 1024 * 1024;

const hydrateSearchMatchesSchema = z.object({
  provider: providerNamespaceSchema,
  candidateKeys: z.array(z.string().min(1)).min(1).max(500),
  query: z.string().min(1).max(512),
  options: stateSearchOptionsSchema.optional(),
  searchOffset: z.number().int().nonnegative().max(MAX_SEARCH_HYDRATION_BYTES).optional(),
  maxBytes: z.number().int().positive().max(MAX_SEARCH_HYDRATION_BYTES),
});

const stateTextMatchSchema = z.object({
  path: z.string(),
  line: z.number(),
  column: z.number(),
  startOffset: z.number(),
  endOffset: z.number(),
  text: z.string(),
  lineText: z.string(),
  contextBefore: z.array(z.string()),
  contextAfter: z.array(z.string()),
});

const errorCodes = [
  "UPLOAD_NOT_FOUND",
  "UPLOAD_ALREADY_ACTIVE",
  "FILE_ALREADY_EXISTS",
  "FILE_PRECONDITION_FAILED",
  "FILE_NOT_FOUND",
  "FILE_DELETED",
  "UPLOAD_EXPIRED",
  "UPLOAD_INVALID_STATE",
  "SIGNED_URL_UNSUPPORTED",
  "STORAGE_ERROR",
  "INVALID_FILE_KEY",
  "INVALID_CHECKSUM",
  "INVALID_REQUEST",
  "PROVIDER_MISMATCH",
  "TEXT_INDEX_DISABLED",
  "TEXT_SEARCH_REGEX_UNSUPPORTED",
] as const;

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Callers project parsed form JSON to a boundary type before validating its shape.
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
    return parsed.filter((tag) => typeof tag === "string");
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
    throw new UploadServiceError("FILE_DELETED", "The file has been deleted.");
  }
  return file;
};

const toSearchPositions = (value: unknown): number[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((position): position is number => Number.isSafeInteger(position));
};

type DirectoryMetadata = z.infer<typeof directoryMetadataSchema>;

type FileMetadataForDirectoryList = ReturnType<typeof toFileMetadata>;

const buildDelimitedFileList = (
  files: FileMetadataForDirectoryList[],
  prefix: string,
  delimiter: string,
): { files: FileMetadataForDirectoryList[]; directories: DirectoryMetadata[] } => {
  const directFiles: FileMetadataForDirectoryList[] = [];
  const directories = new Map<string, DirectoryMetadata>();

  for (const file of files) {
    const remainder = file.fileKey.slice(prefix.length);
    if (!remainder) {
      directFiles.push(file);
      continue;
    }

    const delimiterIndex = remainder.indexOf(delimiter);
    if (delimiterIndex === -1) {
      directFiles.push(file);
      continue;
    }

    const name = remainder.slice(0, delimiterIndex);
    if (!name) {
      continue;
    }

    const directoryPrefix = `${prefix}${name}${delimiter}`;
    const existing = directories.get(directoryPrefix);
    if (!existing) {
      directories.set(directoryPrefix, {
        name,
        prefix: directoryPrefix,
        updatedAt: file.updatedAt,
        contentType: file.contentType,
        metadata: file.metadata,
      });
      continue;
    }

    if (file.updatedAt > (existing.updatedAt ?? "")) {
      existing.updatedAt = file.updatedAt;
    }
  }

  return {
    files: directFiles,
    directories: Array.from(directories.values()).sort((left, right) =>
      left.prefix.localeCompare(right.prefix),
    ),
  };
};

export const fileRoutesFactory = defineRoutes(uploadFragmentDefinition).create(
  ({ services, defineRoute, config }) => {
    const getResolvedConfig = () => resolveUploadFragmentConfig(config);

    const parseListQuery = (query: URLSearchParams) => {
      const result = listQuerySchema.safeParse({
        provider: query.has("provider") ? query.get("provider") : undefined,
        prefix: query.get("prefix") || undefined,
        glob: query.get("glob") || undefined,
        cursor: query.get("cursor") || undefined,
        pageSize: query.has("pageSize") ? query.get("pageSize") : undefined,
        status: query.get("status") || undefined,
        uploaderId: query.get("uploaderId") || undefined,
        delimiter: query.get("delimiter") || undefined,
      });
      if (!result.success) {
        throw new UploadServiceError("INVALID_REQUEST", "The file list query is invalid.");
      }
      return result.data;
    };

    const parseByKeyQuery = (query: URLSearchParams) => {
      const result = byKeyQuerySchema.safeParse({
        provider: query.get("provider"),
        key: query.get("key"),
      });
      if (!result.success) {
        throw new UploadServiceError("INVALID_REQUEST", "The file query is invalid.");
      }

      try {
        const resolvedKey = resolveFileKeyInput({ fileKey: result.data.key });
        return {
          provider: result.data.provider,
          fileKey: resolvedKey.fileKey,
        };
      } catch (cause) {
        if (cause instanceof UploadServiceError) {
          throw cause;
        }
        throw new UploadServiceError("INVALID_FILE_KEY", "The file key is invalid.", undefined, {
          cause,
        });
      }
    };

    return [
      defineRoute({
        method: "POST",
        path: "/files",
        contentType: "multipart/form-data",
        outputSchema: fileMutationResultSchema,
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
          const preconditionValue = form.get("precondition");
          let precondition: z.infer<typeof fileWritePreconditionSchema> | undefined;
          if (preconditionValue !== null) {
            const preconditionResult = fileWritePreconditionSchema.safeParse(
              parseJson<unknown>(preconditionValue),
            );
            if (!preconditionResult.success) {
              return error({ message: "Invalid request", code: "INVALID_REQUEST" }, 400);
            }
            precondition = preconditionResult.data;
          }

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
          } catch (cause) {
            return handleServiceError(mapStorageOperationError(cause), error);
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
                throw new UploadServiceError("STORAGE_ERROR", "Proxy uploads are not supported.");
              }
              await resolvedConfig.storage.writeStream({
                storageKey: storageInit.storageKey,
                body: file.stream(),
                contentType,
                sizeBytes: BigInt(file.size),
              });
            } else if (storageInit.strategy === "direct-single") {
              if (!storageInit.uploadUrl) {
                throw new UploadServiceError(
                  "STORAGE_ERROR",
                  "The storage adapter did not provide an upload URL.",
                );
              }
              const response = await fetch(storageInit.uploadUrl, {
                method: "PUT",
                headers: storageInit.uploadHeaders,
                body: file,
              });
              if (!response.ok) {
                throw new UploadServiceError("STORAGE_ERROR", "The direct upload request failed.");
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
          } catch (cause) {
            const storageError =
              cause instanceof UploadServiceError ? cause : mapStorageOperationError(cause);
            await this.handlerTx()
              .withServiceCalls(() => [
                services.createFailedUpload({
                  ...createInput,
                  storageInit,
                  errorCode: storageError.code,
                  errorMessage: storageError.message,
                }),
              ])
              .execute();
            return handleServiceError(storageError, error);
          }

          try {
            const completed = await this.handlerTx()
              .withServiceCalls(() => [
                services.createCompletedUpload({
                  ...createInput,
                  storageInit,
                  completedSizeBytes: BigInt(file.size),
                  precondition,
                }),
              ])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            return json(toFileMutationResult(completed.file));
          } catch (err) {
            try {
              await resolvedConfig.storage.deleteObject({
                storageKey: storageInit.storageKey,
              });
            } catch (cause) {
              return handleServiceError(mapStorageOperationError(cause), error);
            }
            return handleServiceError(err, error);
          }
        },
      }),

      defineRoute({
        method: "POST",
        path: "/files/apply-edits",
        inputSchema: applyFileEditsSchema,
        outputSchema: applyFileEditsResultSchema,
        errorCodes,
        handler: async function ({ input }, { json, error }) {
          const payload = await input.valid();
          const resolvedConfig = getResolvedConfig();
          if (payload.provider !== resolvedConfig.storage.name) {
            return handleServiceError(
              new UploadServiceError(
                "PROVIDER_MISMATCH",
                "The edit provider does not match the active storage provider.",
              ),
              error,
            );
          }

          let edits: FileEditOperation[];
          try {
            edits = payload.edits.map((edit) => ({
              ...edit,
              fileKey: resolveFileKeyInput({ fileKey: edit.fileKey }).fileKey,
            })) as FileEditOperation[];
          } catch (cause) {
            return handleServiceError(cause, error);
          }

          const fileKeys = Array.from(new Set(edits.map((edit) => edit.fileKey)));
          if (fileKeys.length > MAX_FILE_EDIT_FILES) {
            return handleServiceError(
              new UploadServiceError(
                "INVALID_REQUEST",
                `File edits may address at most ${MAX_FILE_EDIT_FILES} unique files.`,
              ),
              error,
            );
          }

          try {
            const snapshots = (await this.handlerTx()
              .withServiceCalls(() => [
                services.findFilesByKeys({ provider: payload.provider, fileKeys }),
              ])
              .transform(({ serviceResult: [files] }) => files)
              .execute()) as FileRow[];
            const snapshotsByKey = new Map(snapshots.map((file) => [file.key, file]));
            const firstEditByKey = new Map<string, FileEditOperation>();
            for (const edit of edits) {
              if (!firstEditByKey.has(edit.fileKey)) {
                firstEditByKey.set(edit.fileKey, edit);
              }
            }
            const filesRequiringInitialContent = snapshots.filter(
              (file) => file.status === "ready" && firstEditByKey.get(file.key)?.kind === "replace",
            );
            const expectedDownloadBytes = filesRequiringInitialContent.reduce(
              (total, file) => total + file.sizeBytes,
              0n,
            );
            if (expectedDownloadBytes > BigInt(MAX_FILE_EDIT_TEXT_BYTES)) {
              throw new UploadServiceError(
                "INVALID_REQUEST",
                `File edits may read at most ${MAX_FILE_EDIT_TEXT_BYTES} bytes.`,
              );
            }
            if (
              filesRequiringInitialContent.length > 0 &&
              !resolvedConfig.storage.getDownloadStream
            ) {
              throw new UploadServiceError(
                "STORAGE_ERROR",
                "The storage adapter does not support server-side file reads.",
              );
            }

            let downloadedBytes = 0;
            const downloaded = await mapWithConcurrency(
              filesRequiringInitialContent,
              FILE_EDIT_STORAGE_CONCURRENCY,
              async (file) => {
                let response: Response;
                try {
                  response = await resolvedConfig.storage.getDownloadStream!({
                    storageKey: file.objectKey,
                  });
                } catch (cause) {
                  throw mapStorageOperationError(cause);
                }
                if (!response.ok) {
                  throw new UploadServiceError(
                    "STORAGE_ERROR",
                    "The storage adapter could not read an edited file.",
                    { provider: file.provider, fileKey: file.key },
                  );
                }
                let bytes: Uint8Array;
                try {
                  bytes = new Uint8Array(await response.arrayBuffer());
                } catch (cause) {
                  throw mapStorageOperationError(cause);
                }
                downloadedBytes += bytes.byteLength;
                if (downloadedBytes > MAX_FILE_EDIT_TEXT_BYTES) {
                  throw new UploadServiceError(
                    "INVALID_REQUEST",
                    `File edits may read at most ${MAX_FILE_EDIT_TEXT_BYTES} bytes.`,
                  );
                }
                try {
                  return [
                    file.key,
                    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
                  ] as const;
                } catch (cause) {
                  throw new UploadServiceError(
                    "INVALID_REQUEST",
                    "Edited files must contain valid UTF-8 text.",
                    { provider: file.provider, fileKey: file.key },
                    { cause },
                  );
                }
              },
            );
            const initialContents = new Map(downloaded);
            const currentContents = new Map<string, string | null>(
              fileKeys.map((fileKey) => [fileKey, initialContents.get(fileKey) ?? null]),
            );
            const operationResults = [];
            let generatedBytes = 0;

            for (const edit of edits) {
              const previous = currentContents.get(edit.fileKey) ?? null;
              let content: string;
              try {
                content = applyFileEditOperation(previous, edit);
              } catch (cause) {
                if (cause instanceof FileEditError) {
                  if (previous === null && edit.kind === "replace") {
                    throw new UploadServiceError("FILE_NOT_FOUND", cause.message, {
                      provider: payload.provider,
                      fileKey: edit.fileKey,
                    });
                  }
                  throw new UploadServiceError("INVALID_REQUEST", cause.message, {
                    provider: payload.provider,
                    fileKey: edit.fileKey,
                  });
                }
                throw cause;
              }
              generatedBytes += new TextEncoder().encode(content).byteLength;
              if (generatedBytes > MAX_FILE_EDIT_TEXT_BYTES) {
                throw new UploadServiceError(
                  "INVALID_REQUEST",
                  `File edits may generate at most ${MAX_FILE_EDIT_TEXT_BYTES} bytes.`,
                );
              }
              let diff: string;
              try {
                diff = diffContent(
                  previous ?? "",
                  content,
                  `a/${edit.fileKey}`,
                  `b/${edit.fileKey}`,
                );
              } catch (cause) {
                if (cause instanceof FileEditError) {
                  throw new UploadServiceError("INVALID_REQUEST", cause.message, {
                    provider: payload.provider,
                    fileKey: edit.fileKey,
                  });
                }
                throw cause;
              }
              operationResults.push({
                fileKey: edit.fileKey,
                changed: previous !== content,
                content,
                diff,
              });
              currentContents.set(edit.fileKey, content);
            }

            const changedFiles: EvaluatedFile[] = fileKeys.flatMap((fileKey) => {
              const snapshot = snapshotsByKey.get(fileKey) ?? null;
              const original = snapshot?.status === "ready" ? snapshot : null;
              const originalContent = initialContents.get(fileKey) ?? null;
              const content = currentContents.get(fileKey);
              if (content === null || content === undefined || content === originalContent) {
                return [];
              }
              const lastOperation = edits.findLast((edit) => edit.fileKey === fileKey)!;
              // TODO: Track publication metadata from the latest write/writeJson operation per
              // file. A later replace only transforms content and must not change a new JSON
              // file's content type back to text/plain.
              return [
                {
                  fileKey,
                  original,
                  content,
                  contentType:
                    original?.contentType ??
                    (lastOperation.kind === "writeJson" ? "application/json" : "text/plain"),
                  filename: original?.filename ?? fileKey.split("/").at(-1)!,
                },
              ];
            });

            if (changedFiles.length > 0 && !resolvedConfig.storage.writeStream) {
              throw new UploadServiceError(
                "STORAGE_ERROR",
                "The storage adapter does not support server-side file writes.",
              );
            }

            const stagedObjects: Array<{
              file: EvaluatedFile;
              bytes: Uint8Array;
              storageInit: Awaited<ReturnType<typeof resolvedConfig.storage.initUpload>>;
            }> = [];
            const initializedStorageWrites: typeof stagedObjects = [];
            try {
              const staged = await mapWithConcurrency(
                changedFiles,
                FILE_EDIT_STORAGE_CONCURRENCY,
                async (file) => {
                  const bytes = new TextEncoder().encode(file.content);
                  let storageInit;
                  try {
                    storageInit = await resolvedConfig.storage.initUpload({
                      provider: payload.provider,
                      fileKey: resolveFileKeyInput({ fileKey: file.fileKey }).fileKey,
                      sizeBytes: BigInt(bytes.byteLength),
                      contentType: file.contentType,
                      checksum: null,
                      metadata: file.original?.metadata ?? null,
                      objectKeyVersionSegment: buildStorageObjectVersionSegment(),
                    });
                    if (storageInit.strategy !== "proxy") {
                      if (
                        storageInit.strategy === "direct-multipart" &&
                        storageInit.storageUploadId &&
                        resolvedConfig.storage.abortMultipartUpload
                      ) {
                        try {
                          await resolvedConfig.storage.abortMultipartUpload({
                            storageKey: storageInit.storageKey,
                            storageUploadId: storageInit.storageUploadId,
                          });
                        } catch {
                          // The edit request is invalid for this strategy even when abort fails.
                        }
                      }
                      throw new UploadServiceError(
                        "STORAGE_ERROR",
                        "Server-side file edits require the proxy upload strategy.",
                      );
                    }
                    const stagedObject = { file, bytes, storageInit };
                    initializedStorageWrites.push(stagedObject);
                    await resolvedConfig.storage.writeStream!({
                      storageKey: storageInit.storageKey,
                      body: new Blob([bytes]).stream(),
                      contentType: file.contentType,
                      sizeBytes: BigInt(bytes.byteLength),
                    });
                    if (resolvedConfig.storage.finalizeUpload) {
                      await resolvedConfig.storage.finalizeUpload({
                        storageKey: storageInit.storageKey,
                        expectedSizeBytes: BigInt(bytes.byteLength),
                        checksum: null,
                      });
                    }
                  } catch (cause) {
                    throw mapStorageOperationError(cause);
                  }
                  return { file, bytes, storageInit };
                },
              );
              stagedObjects.push(...staged);
            } catch (cause) {
              await Promise.allSettled(
                initializedStorageWrites.map(({ storageInit }) =>
                  resolvedConfig.storage.deleteObject({ storageKey: storageInit.storageKey }),
                ),
              );
              throw cause;
            }

            let prepared: Array<{ uploadId: string }> = [];
            if (stagedObjects.length > 0) {
              // TODO: Reconcile staged object keys against prepared-upload rows so objects can be
              // deleted after a known rollback while preserving them after an ambiguous commit.
              // Until then, retain staged objects on database errors because the commit may have
              // succeeded even when its acknowledgement was lost.
              prepared = await this.handlerTx()
                .withServiceCalls(() => [
                  services.createPreparedFileUploads(
                    stagedObjects.map(({ file, bytes, storageInit }) => ({
                      provider: payload.provider,
                      fileKey: file.fileKey,
                      filename: file.filename,
                      sizeBytes: bytes.byteLength,
                      contentType: file.contentType,
                      checksum: null,
                      tags: file.original?.tags ?? undefined,
                      visibility: file.original?.visibility as
                        | "private"
                        | "public"
                        | "unlisted"
                        | undefined,
                      uploaderId: file.original?.uploaderId ?? undefined,
                      metadata: file.original?.metadata ?? undefined,
                      publicationMode: "batch",
                      storageInit,
                      completedSizeBytes: BigInt(bytes.byteLength),
                    })),
                  ),
                ])
                .transform(({ serviceResult: [uploads] }) => uploads)
                .execute();
            }

            const preparedByKey = new Map(
              prepared.map((upload, index) => [changedFiles[index].fileKey, upload]),
            );
            const changedKeys = new Set(changedFiles.map((file) => file.fileKey));
            const entries: PreparedFileBatchEntry[] = fileKeys.map((fileKey) => {
              const original = snapshotsByKey.get(fileKey);
              const precondition =
                original?.status === "ready"
                  ? { kind: "revision" as const, revision: original.id.version }
                  : { kind: "absent" as const };
              const preparedUpload = preparedByKey.get(fileKey);
              return changedKeys.has(fileKey) && preparedUpload
                ? { kind: "write" as const, uploadId: preparedUpload.uploadId, precondition }
                : {
                    kind: "assert" as const,
                    provider: payload.provider,
                    fileKey,
                    precondition,
                  };
            });

            await this.handlerTx()
              .withServiceCalls(() => [
                services.commitPreparedFileWrites({
                  entries,
                  activeProvider: payload.provider,
                }),
              ])
              .execute();

            return json({ edits: operationResults, totalChanged: changedFiles.length });
          } catch (cause) {
            return handleServiceError(cause, error);
          }
        },
      }),

      defineRoute({
        method: "POST",
        path: "/files/commit-prepared",
        inputSchema: commitPreparedFilesSchema,
        outputSchema: z.object({ files: z.array(fileMutationSnapshotSchema) }),
        errorCodes,
        handler: async function ({ input }, { json, error }) {
          const payload = await input.valid();
          const activeProvider = getResolvedConfig().storage.name;
          try {
            const entries = payload.entries.map((entry) =>
              entry.kind === "write"
                ? entry
                : {
                    ...entry,
                    fileKey: resolveFileKeyInput({ fileKey: entry.fileKey }).fileKey,
                  },
            );
            const result = await this.handlerTx()
              .withServiceCalls(() => [
                services.commitPreparedFileWrites({ entries, activeProvider }),
              ])
              .transform(({ serviceResult: [committed] }) => committed)
              .execute();

            return json({
              files: result.files.map((file) => ({
                ...toFileMutationResult(file),
                revision: file.revision,
              })),
            });
          } catch (err) {
            return handleServiceError(err, error);
          }
        },
      }),

      defineRoute({
        method: "GET",
        path: "/files",
        queryParameters: [
          "provider",
          "prefix",
          "glob",
          "cursor",
          "pageSize",
          "status",
          "uploaderId",
          "delimiter",
        ],
        outputSchema: z.object({
          files: z.array(fileMetadataSchema),
          directories: z.array(directoryMetadataSchema).optional(),
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

          const globPattern = params.glob ? globToRegExp(params.glob) : null;
          const result = await this.handlerTx()
            .withServiceCalls(() => [
              services.listFiles({
                provider: params.provider,
                prefix: params.glob ? getStaticGlobPrefix(params.glob) : params.prefix,
                pageSize: params.pageSize,
                cursor: params.cursor,
                status: params.status,
                uploaderId: params.uploaderId,
              }),
            ])
            .transform(({ serviceResult: [files] }) => files)
            .execute();

          const files = [];
          for (const item of result.items) {
            const file = toFileMetadata(item);
            if (!globPattern || globPattern.test(file.fileKey)) {
              files.push(file);
            }
          }
          if (params.delimiter) {
            const delimited = buildDelimitedFileList(files, params.prefix ?? "", params.delimiter);
            return json({
              files: delimited.files,
              directories: delimited.directories,
              cursor: result.cursor?.encode(),
              hasNextPage: result.hasNextPage,
            });
          }

          return json({
            files,
            cursor: result.cursor?.encode(),
            hasNextPage: result.hasNextPage,
          });
        },
      }),

      // Complex read endpoints use POST so callers can send structured search options
      // without query-string encoding or URL length limits.
      defineRoute({
        method: "POST",
        path: "/files/search",
        inputSchema: searchFilesSchema,
        outputSchema: z.object({
          provider: providerNamespaceSchema,
          candidates: z.array(searchFileCandidateSchema),
          candidateFiles: z.number(),
          cursor: z.string().optional(),
          hasMoreCandidates: z.boolean(),
        }),
        errorCodes,
        handler: async function ({ input }, { json, error }) {
          const resolvedConfig = getResolvedConfig();
          const payload = await input.valid();
          const options = payload.options ?? {};

          if (!resolvedConfig.textIndex?.enabled) {
            return handleServiceError(
              new UploadServiceError("TEXT_INDEX_DISABLED", "The text index is disabled."),
              error,
            );
          }

          if (options.regex) {
            return handleServiceError(
              new UploadServiceError(
                "TEXT_SEARCH_REGEX_UNSUPPORTED",
                "Regex search is not supported by the text index.",
              ),
              error,
            );
          }

          const searchTerms = extractTextIndexTerms(payload.query, resolvedConfig.textIndex);
          const searchTerm = searchTerms[0];
          const globPrefix = getStaticGlobPrefix(payload.glob);
          const globPattern = globToRegExp(payload.glob);
          const maxCandidateFiles = payload.maxCandidateFiles ?? 200;

          const candidatePage = searchTerm
            ? await (async () => {
                const [page] = await this.handlerTx()
                  .retrieve(({ forSchema }) =>
                    forSchema(uploadSchema).findWithCursor("file_text_term", (b) => {
                      const query = b
                        .whereIndex("idx_file_text_term_provider_term_key", (eb) =>
                          eb.and(
                            eb("provider", "=", payload.provider),
                            eb("term", "=", searchTerm),
                            eb("key", "starts with", globPrefix),
                          ),
                        )
                        .orderByIndex("idx_file_text_term_provider_term_key", "asc")
                        .pageSize(maxCandidateFiles)
                        .joinOne("document", "file_text_document", (document) =>
                          document.onIndex("primary", (eb) =>
                            eb("id", "=", eb.parent("documentId")),
                          ),
                        );

                      return payload.cursor ? query.after(payload.cursor) : query;
                    }),
                  )
                  .execute();

                return {
                  candidates: page.items.flatMap((candidate) => {
                    const document = candidate.document;
                    if (!document || !globPattern.test(document.key)) {
                      return [];
                    }
                    return [
                      {
                        key: document.key,
                        positions: toSearchPositions(candidate.positions),
                        count: candidate.count,
                      },
                    ];
                  }),
                  cursor: page.cursor?.encode(),
                  hasMoreCandidates: page.hasNextPage,
                };
              })()
            : await (async () => {
                const [page] = await this.handlerTx()
                  .retrieve(({ forSchema }) =>
                    forSchema(uploadSchema).findWithCursor("file_text_document", (b) => {
                      const query = b
                        .whereIndex("idx_file_text_document_provider_key", (eb) =>
                          eb.and(
                            eb("provider", "=", payload.provider),
                            eb("key", "starts with", globPrefix),
                          ),
                        )
                        .orderByIndex("idx_file_text_document_provider_key", "asc")
                        .pageSize(maxCandidateFiles);
                      return payload.cursor ? query.after(payload.cursor) : query;
                    }),
                  )
                  .execute();

                return {
                  candidates: page.items.flatMap((document) =>
                    globPattern.test(document.key)
                      ? [{ key: document.key, positions: [], count: 0 }]
                      : [],
                  ),
                  cursor: page.cursor?.encode(),
                  hasMoreCandidates: page.hasNextPage,
                };
              })();

          const candidates = candidatePage.candidates;

          return json({
            provider: payload.provider,
            candidates,
            candidateFiles: candidates.length,
            cursor: candidatePage.cursor,
            hasMoreCandidates: candidatePage.hasMoreCandidates,
          });
        },
      }),

      // Hydration is read-only, but explicit candidate pages and search options belong in a body.
      defineRoute({
        method: "POST",
        path: "/files/search/hydrate",
        inputSchema: hydrateSearchMatchesSchema,
        outputSchema: z.object({
          matches: z.array(stateTextMatchSchema),
          scannedFiles: z.number(),
          scannedBytes: z.number(),
          consumedCandidates: z.number(),
          skippedCandidates: z.array(
            z.object({
              key: z.string(),
              reason: z.enum(["not_found", "too_large"]),
            }),
          ),
          nextSearchOffset: z.number().int().nonnegative().optional(),
          truncated: z.union([
            z.literal(false),
            z.object({ reason: z.enum(["max_matches", "max_bytes"]) }),
          ]),
        }),
        errorCodes,
        handler: async function ({ input }, { json, error }) {
          const resolvedConfig = getResolvedConfig();
          const payload = await input.valid();
          const options = payload.options ?? {};
          const maxMatches = options.maxMatches ?? 50;

          if (!resolvedConfig.textIndex?.enabled) {
            return handleServiceError(
              new UploadServiceError("TEXT_INDEX_DISABLED", "The text index is disabled."),
              error,
            );
          }

          if (options.regex) {
            return handleServiceError(
              new UploadServiceError(
                "TEXT_SEARCH_REGEX_UNSUPPORTED",
                "Regex search is not supported by the text index.",
              ),
              error,
            );
          }

          if (!resolvedConfig.storage.getDownloadStream) {
            return handleServiceError(
              new UploadServiceError("STORAGE_ERROR", "File downloads are not supported."),
              error,
            );
          }

          const [documents] = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(uploadSchema).find("file_text_document", (b) =>
                b.whereIndex("idx_file_text_document_provider_key", (eb) =>
                  eb.and(
                    eb("provider", "=", payload.provider),
                    eb("key", "in", payload.candidateKeys),
                  ),
                ),
              ),
            )
            .execute();

          const documentsByKey = new Map(documents.map((document) => [document.key, document]));
          const matches = [];
          const skippedCandidates: Array<{
            key: string;
            reason: "not_found" | "too_large";
          }> = [];
          const maxBytes = BigInt(payload.maxBytes);
          let scannedFiles = 0;
          let scannedBytes = 0n;
          let consumedCandidates = 0;
          let currentCandidateSearchOffset = payload.searchOffset ?? 0;
          let nextSearchOffset: number | undefined;
          let truncated: false | { reason: "max_matches" | "max_bytes" } = false;

          for (const candidateKey of payload.candidateKeys) {
            if (matches.length >= maxMatches) {
              truncated = { reason: "max_matches" };
              nextSearchOffset = currentCandidateSearchOffset;
              break;
            }

            const document = documentsByKey.get(candidateKey);
            if (!document) {
              skippedCandidates.push({ key: candidateKey, reason: "not_found" });
              consumedCandidates += 1;
              currentCandidateSearchOffset = 0;
              continue;
            }

            if (document.byteLength > maxBytes) {
              skippedCandidates.push({ key: candidateKey, reason: "too_large" });
              consumedCandidates += 1;
              currentCandidateSearchOffset = 0;
              continue;
            }
            if (scannedBytes + document.byteLength > maxBytes) {
              truncated = { reason: "max_bytes" };
              nextSearchOffset = currentCandidateSearchOffset;
              break;
            }

            const response = await resolvedConfig.storage.getDownloadStream({
              storageKey: document.objectKey,
            });
            if (!response.ok) {
              return handleServiceError(
                new UploadServiceError("STORAGE_ERROR", "The file download failed."),
                error,
              );
            }

            scannedFiles += 1;
            scannedBytes += document.byteLength;
            const text = await response.text();
            const remainingMatches: number = maxMatches - matches.length;
            const candidateMatches: ReturnType<typeof searchTextContent> = searchTextContent(
              document.key,
              text,
              payload.query,
              {
                ...options,
                startOffset: currentCandidateSearchOffset,
                maxMatches: remainingMatches + 1,
              },
            );

            matches.push(...candidateMatches.slice(0, remainingMatches));
            if (candidateMatches.length > remainingMatches) {
              truncated = { reason: "max_matches" };
              nextSearchOffset = candidateMatches[remainingMatches]?.startOffset;
              break;
            }

            consumedCandidates += 1;
            currentCandidateSearchOffset = 0;
          }

          return json({
            matches,
            scannedFiles,
            scannedBytes: Number(scannedBytes),
            consumedCandidates,
            skippedCandidates,
            ...(nextSearchOffset === undefined ? {} : { nextSearchOffset }),
            truncated,
          });
        },
      }),

      defineRoute({
        method: "GET",
        path: "/files/by-key",
        queryParameters: ["provider", "key"],
        outputSchema: fileSnapshotSchema,
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

            return json({
              ...toFileMetadata(file),
              revision: file.id.version,
            });
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
        outputSchema: fileMutationResultSchema,
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

            return json(toFileMutationResult(file));
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
