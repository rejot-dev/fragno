import type { TableToColumnValues } from "@fragno-dev/db/query";
import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";
import type { TypedUnitOfWork } from "@fragno-dev/db";

import { uploadFragmentDefinition } from "../definition";
import type { FileEditOperation } from "../file-edits";
import { uploadSchema } from "../schema";
import { assertFileSize } from "../services/content";
import { UploadServiceError } from "../services/errors";
import { MAX_FILE_EDIT_TEXT_BYTES } from "../services/files";
import { resolveFileKeyInput } from "../services/helpers";
import { chunkQueryValues } from "../services/query-chunks";
import { MAX_PREPARED_FILE_BATCH_ENTRIES } from "../services/uploads";
import {
  extractTextIndexTerms,
  getStaticGlobPrefix,
  globToRegExp,
  searchTextContent,
  selectSearchCandidateTerm,
} from "../text-index";
import {
  checksumSchema,
  fileMetadataSchema,
  fileMutationResultSchema,
  fileMutationSnapshotSchema,
  fileSnapshotSchema,
  fileWritePreconditionSchema,
  toFileMetadata,
  toFileMutationResult,
  visibilitySchema,
} from "./shared";
import { handleUploadServiceError as handleServiceError } from "./uploads-errors";

type IndexedDocumentRow = TableToColumnValues<typeof uploadSchema.tables.file_text_document> & {
  object: { body: Uint8Array } | null;
};

const legacyFileKeyPartsSchema = z.array(z.union([z.string(), z.number().int()]));

const listQuerySchema = z
  .object({
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
    fileKey: z.string().min(1),
    precondition: z.object({
      kind: z.literal("revision"),
      revision: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    kind: z.literal("assert"),
    fileKey: z.string().min(1),
    precondition: fileWritePreconditionSchema,
  }),
]);

const commitPreparedFilesSchema = z.object({
  entries: z.array(preparedFileBatchEntrySchema).min(1).max(MAX_PREPARED_FILE_BATCH_ENTRIES),
});

const MAX_FILE_EDIT_OPERATIONS = 10;
const MAX_FILE_EDIT_FILES = 10;
const MAX_FILE_EDIT_PATTERN_LENGTH = 16 * 1024;

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

const MAX_SEARCH_KEYWORDS = 8;

// Candidates come from one index pass per keyword; `indexCursor` resumes within `pass`.
const searchCandidateCursorSchema = z.object({
  pass: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_SEARCH_KEYWORDS - 1),
  indexCursor: z.string().optional(),
});

const searchFilesSchema = z.object({
  glob: z.string().min(1).max(512),
  keywords: z.array(z.string().min(1).max(512)).min(1).max(MAX_SEARCH_KEYWORDS),
  options: stateSearchOptionsSchema.optional(),
  maxCandidateFiles: z.number().int().min(1).max(500).optional(),
  cursor: searchCandidateCursorSchema.optional(),
});

const searchFileCandidateSchema = z.object({
  key: z.string(),
  positions: z.array(z.number()),
  count: z.number(),
  /** The indexed content's size, so callers can hydrate as many candidates as their budget scans. */
  byteLength: z.number(),
});

const MAX_SEARCH_HYDRATION_BYTES = 30 * 1024 * 1024;

const hydrateSearchMatchesSchema = z.object({
  candidateKeys: z.array(z.string().min(1)).min(1).max(500),
  keywords: z.array(z.string().min(1).max(512)).min(1).max(MAX_SEARCH_KEYWORDS),
  /** Files containing any of these index terms were candidates of an earlier pass. */
  excludedTerms: z.array(z.string()).max(MAX_SEARCH_KEYWORDS),
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
  "FILE_PRECONDITION_FAILED",
  "FILE_NOT_FOUND",
  "FILE_DELETED",
  "FILE_TOO_LARGE",
  "UPLOAD_EXPIRED",
  "UPLOAD_INVALID_STATE",
  "INVALID_FILE_KEY",
  "INVALID_CHECKSUM",
  "INVALID_REQUEST",
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
    const parseListQuery = (query: URLSearchParams) => {
      const result = listQuerySchema.safeParse({
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
        key: query.get("key"),
      });
      if (!result.success) {
        throw new UploadServiceError("INVALID_REQUEST", "The file query is invalid.");
      }

      try {
        const resolvedKey = resolveFileKeyInput({ fileKey: result.data.key });
        return { fileKey: resolvedKey.fileKey };
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
          const form = context.formData();
          const file = form.get("file");
          if (!(file instanceof Blob)) {
            return error({ message: "File is required", code: "INVALID_REQUEST" }, 400);
          }

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

          const uploaderIdValue = form.get("uploaderId");
          const visibilityValue = form.get("visibility");
          const visibilityResult = visibilitySchema
            .optional()
            .safeParse(typeof visibilityValue === "string" ? visibilityValue : undefined);
          if (!visibilityResult.success) {
            return error({ message: "Invalid request", code: "INVALID_REQUEST" }, 400);
          }
          const filenameValue = form.get("filename");
          const filename =
            typeof filenameValue === "string" && filenameValue
              ? filenameValue
              : file instanceof File && file.name
                ? file.name
                : "upload";

          try {
            assertFileSize(file.size, config.maxFileBytes, `File '${resolvedKey.fileKey}'`);
            const content = new Uint8Array(await file.arrayBuffer());
            const [written] = await this.handlerTx()
              .withServiceCalls(() => [
                services.writeFiles([
                  {
                    fileKey: resolvedKey.fileKey,
                    content,
                    filename,
                    contentType: file.type || "application/octet-stream",
                    checksum: checksumResult.data ?? null,
                    visibility: visibilityResult.data ?? "private",
                    tags: tags ?? null,
                    metadata: metadata ?? null,
                    uploaderId: typeof uploaderIdValue === "string" ? uploaderIdValue : null,
                    precondition: precondition ?? null,
                  },
                ]),
              ])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            return json(toFileMutationResult(written));
          } catch (err) {
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
          try {
            const edits = payload.edits.map((edit) => ({
              ...edit,
              fileKey: resolveFileKeyInput({ fileKey: edit.fileKey }).fileKey,
            })) as FileEditOperation[];
            if (new Set(edits.map((edit) => edit.fileKey)).size > MAX_FILE_EDIT_FILES) {
              throw new UploadServiceError(
                "INVALID_REQUEST",
                `File edits may address at most ${MAX_FILE_EDIT_FILES} unique files.`,
              );
            }

            const result = await this.handlerTx()
              .withServiceCalls(() => [services.applyFileEdits(edits)])
              .transform(({ serviceResult: [applied] }) => applied)
              .execute();
            return json(result);
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
              .withServiceCalls(() => [services.commitPreparedFileWrites(entries)])
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

      // Batch snapshots preserve revisions and deleted rows without one lookup per key.
      defineRoute({
        method: "POST",
        path: "/files/snapshots",
        inputSchema: z.object({
          fileKeys: z.array(z.string().min(1)).min(1).max(500),
        }),
        outputSchema: z.object({ files: z.array(fileSnapshotSchema) }),
        errorCodes,
        handler: async function ({ input }, { json, error }) {
          const payload = await input.valid();
          let fileKeys: string[];
          try {
            fileKeys = payload.fileKeys.map((fileKey) => resolveFileKeyInput({ fileKey }).fileKey);
          } catch (cause) {
            return handleServiceError(cause, error);
          }
          const files = await this.handlerTx()
            .withServiceCalls(() => [services.findFilesByKeys({ fileKeys })])
            .transform(({ serviceResult: [files] }) =>
              files.map((file) => ({ ...toFileMetadata(file), revision: file.id.version })),
            )
            .execute();
          return json({ files });
        },
      }),

      // Complex read endpoints use POST so callers can send structured search options
      // without query-string encoding or URL length limits.
      defineRoute({
        method: "POST",
        path: "/files/search",
        inputSchema: searchFilesSchema,
        outputSchema: z.object({
          candidates: z.array(searchFileCandidateSchema),
          candidateFiles: z.number(),
          /** Pass these to hydration so files from earlier passes are not matched twice. */
          excludedTerms: z.array(z.string()),
          cursor: searchCandidateCursorSchema.optional(),
          hasMoreCandidates: z.boolean(),
        }),
        errorCodes,
        handler: async function ({ input }, { json, error }) {
          const payload = await input.valid();
          const options = payload.options ?? {};

          if (!config.textIndex?.enabled) {
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

          const candidateTerms = payload.keywords.map((keyword) =>
            selectSearchCandidateTerm(keyword, config.textIndex),
          );
          // A keyword without an indexable term can occur in any file, so one full-document pass
          // then covers every keyword.
          const passTerms = candidateTerms.every((term): term is string => term !== null)
            ? [...new Set(candidateTerms)]
            : null;
          const cursor = payload.cursor ?? { pass: 0 };
          if (cursor.pass >= (passTerms?.length ?? 1)) {
            return handleServiceError(
              new UploadServiceError("INVALID_REQUEST", "The search cursor has no such pass."),
              error,
            );
          }
          const searchTerm = passTerms?.[cursor.pass];
          const globPrefix = getStaticGlobPrefix(payload.glob);
          const globPattern = globToRegExp(payload.glob);
          const maxCandidateFiles = payload.maxCandidateFiles ?? 200;

          const candidatePage = searchTerm
            ? await (async () => {
                const [page] = await this.handlerTx()
                  .retrieve(({ forSchema }) =>
                    forSchema(uploadSchema).findWithCursor("file_text_term", (b) => {
                      const query = b
                        .whereIndex("idx_file_text_term_term_key", (eb) =>
                          eb.and(eb("term", "=", searchTerm), eb("key", "starts with", globPrefix)),
                        )
                        .orderByIndex("idx_file_text_term_term_key", "asc")
                        .pageSize(maxCandidateFiles)
                        .joinOne("document", "file_text_document", (document) =>
                          document.onIndex("primary", (eb) =>
                            eb("id", "=", eb.parent("documentId")),
                          ),
                        );

                      return cursor.indexCursor ? query.after(cursor.indexCursor) : query;
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
                        byteLength: Number(document.byteLength),
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
                        .whereIndex("idx_file_text_document_key", (eb) =>
                          eb("key", "starts with", globPrefix),
                        )
                        .orderByIndex("idx_file_text_document_key", "asc")
                        .pageSize(maxCandidateFiles);
                      return cursor.indexCursor ? query.after(cursor.indexCursor) : query;
                    }),
                  )
                  .execute();

                return {
                  candidates: page.items.flatMap((document) =>
                    globPattern.test(document.key)
                      ? [
                          {
                            key: document.key,
                            positions: [],
                            count: 0,
                            byteLength: Number(document.byteLength),
                          },
                        ]
                      : [],
                  ),
                  cursor: page.cursor?.encode(),
                  hasMoreCandidates: page.hasNextPage,
                };
              })();

          const candidates = candidatePage.candidates;
          const nextCursor = candidatePage.hasMoreCandidates
            ? { pass: cursor.pass, indexCursor: candidatePage.cursor }
            : passTerms && cursor.pass + 1 < passTerms.length
              ? { pass: cursor.pass + 1 }
              : undefined;

          return json({
            candidates,
            candidateFiles: candidates.length,
            excludedTerms: passTerms?.slice(0, cursor.pass) ?? [],
            ...(nextCursor ? { cursor: nextCursor } : {}),
            hasMoreCandidates: nextCursor !== undefined,
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
          const payload = await input.valid();
          const options = payload.options ?? {};
          const maxMatches = options.maxMatches ?? 50;

          if (!config.textIndex?.enabled) {
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

          // Reads every candidate's content along with its document, so callers hydrate only as
          // many candidates as their byte budget scans.
          const documents = await this.handlerTx()
            .retrieve(({ forSchema }) => {
              const uow = forSchema(uploadSchema);
              for (const candidateKeys of chunkQueryValues(payload.candidateKeys)) {
                uow.find("file_text_document", (b) =>
                  b
                    .whereIndex("idx_file_text_document_key", (eb) =>
                      eb("key", "in", candidateKeys),
                    )
                    .joinOne("object", "storage_object", (object) =>
                      object
                        .onIndex("idx_storage_object_key", (eb) =>
                          eb("storageKey", "=", eb.parent("objectKey")),
                        )
                        .select(["body"]),
                    ),
                );
              }
              return uow as unknown as TypedUnitOfWork<typeof uploadSchema, IndexedDocumentRow[][]>;
            })
            .transformRetrieve((chunks) => chunks.flat())
            .execute();

          const documentsByKey = new Map(documents.map((document) => [document.key, document]));
          const maxBytes = BigInt(payload.maxBytes);
          const excludedTerms = new Set(payload.excludedTerms);
          const matches = [];
          const skippedCandidates: Array<{
            key: string;
            reason: "not_found" | "too_large";
          }> = [];
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
            // A replaced file's document names the content its write deleted, until reindexing.
            const content = document.object?.body;
            if (!content) {
              skippedCandidates.push({ key: candidateKey, reason: "not_found" });
              consumedCandidates += 1;
              currentCandidateSearchOffset = 0;
              continue;
            }

            scannedFiles += 1;
            scannedBytes += document.byteLength;
            const text = new TextDecoder().decode(content);
            if (
              excludedTerms.size > 0 &&
              extractTextIndexTerms(text, config.textIndex).some((term) => excludedTerms.has(term))
            ) {
              consumedCandidates += 1;
              currentCandidateSearchOffset = 0;
              continue;
            }
            const remainingMatches: number = maxMatches - matches.length;
            const candidateMatches: ReturnType<typeof searchTextContent> = searchTextContent(
              document.key,
              text,
              payload.keywords,
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
        queryParameters: ["key"],
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
        queryParameters: ["key"],
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
        queryParameters: ["key"],
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
        path: "/files/by-key/content",
        queryParameters: ["key"],
        errorCodes,
        handler: async function ({ query }, { error }) {
          try {
            const byKey = parseByKeyQuery(query);
            const { file, body } = await this.handlerTx()
              .withServiceCalls(() => [services.getFileContent(byKey)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            return new Response(body.slice(), {
              headers: {
                "Content-Type": file.contentType,
                "Content-Length": String(body.byteLength),
              },
            });
          } catch (err) {
            return handleServiceError(err, error);
          }
        },
      }),
    ];
  },
);
