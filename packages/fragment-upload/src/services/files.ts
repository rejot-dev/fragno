import type { TypedUnitOfWork } from "@fragno-dev/db";

import type { UploadFragmentConfig } from "../config";
import {
  applyFileEditOperation,
  diffContent,
  FileEditError,
  type AppliedFileEdit,
  type FileEditOperation,
} from "../file-edits";
import { uploadSchema } from "../schema";
import type {
  FileStatus,
  FileVisibility,
  UploadChecksum,
  UploadFileWritePrecondition,
} from "../types";
import { assertFileSize, newObjectKey } from "./content";
import type { UploadHooks, UploadMutationUnitOfWork, UploadServiceContext } from "./context";
import { UploadServiceError } from "./errors";
import {
  assertFileWritePrecondition,
  deleteFileContent,
  publishFileContent,
  type StoredFileRow,
} from "./file-publication";
import { chunkQueryValues } from "./query-chunks";

export const MAX_FILE_EDIT_TEXT_BYTES = 10 * 1024 * 1024;

export type FileByKeyInput = {
  provider: string;
  fileKey: string;
};

export type FilesByKeysInput = {
  provider: string;
  fileKeys: string[];
};

export type ListFilesInput = {
  provider?: string;
  prefix?: string;
  pageSize: number;
  cursor?: string;
  status?: FileStatus;
  uploaderId?: string;
};

export type UpdateFileInput = {
  filename?: string;
  visibility?: string;
  tags?: string[] | null;
  metadata?: Record<string, unknown> | null;
};

/** One file's new content, and everything the file publishes about it. */
export type FileContentWrite = {
  fileKey: string;
  content: Uint8Array;
  filename: string;
  contentType: string;
  checksum: UploadChecksum | null;
  visibility: FileVisibility;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
  uploaderId: string | null;
  precondition: UploadFileWritePrecondition | null;
};

function decodeEditedText(provider: string, fileKey: string, body: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch (cause) {
    throw new UploadServiceError(
      "INVALID_REQUEST",
      "Edited files must contain valid UTF-8 text.",
      { provider, fileKey },
      { cause },
    );
  }
}

/** Applies the edits in order to the files' current text, as one atomic change. */
function evaluateFileEdits(
  provider: string,
  edits: FileEditOperation[],
  initialContents: Map<string, string | null>,
) {
  const currentContents = new Map(initialContents);
  const results: AppliedFileEdit[] = [];
  let generatedBytes = 0;

  for (const edit of edits) {
    const previous = currentContents.get(edit.fileKey) ?? null;
    let content: string;
    let diff: string;
    try {
      content = applyFileEditOperation(previous, edit);
      diff = diffContent(previous ?? "", content, `a/${edit.fileKey}`, `b/${edit.fileKey}`);
    } catch (cause) {
      if (!(cause instanceof FileEditError)) {
        throw cause;
      }
      throw new UploadServiceError(
        previous === null && edit.kind === "replace" ? "FILE_NOT_FOUND" : "INVALID_REQUEST",
        cause.message,
        { provider, fileKey: edit.fileKey },
      );
    }
    generatedBytes += new TextEncoder().encode(content).byteLength;
    if (generatedBytes > MAX_FILE_EDIT_TEXT_BYTES) {
      throw new UploadServiceError(
        "INVALID_REQUEST",
        `File edits may generate at most ${MAX_FILE_EDIT_TEXT_BYTES} bytes.`,
      );
    }
    results.push({ fileKey: edit.fileKey, changed: previous !== content, content, diff });
    currentContents.set(edit.fileKey, content);
  }

  return { results, finalContents: currentContents };
}

export const createFileServices = (config: UploadFragmentConfig) => {
  return {
    findFilesByKeys: function (this: UploadServiceContext, input: FilesByKeysInput) {
      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.find("file", (b) =>
            b.whereIndex("idx_file_provider_key", (eb) =>
              eb.and(eb("provider", "=", input.provider), eb("key", "in", input.fileKeys)),
            ),
          ),
        )
        .transformRetrieve(([files]) => files)
        .build();
    },

    getFileByKey: function (this: UploadServiceContext, input: FileByKeyInput) {
      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.findFirst("file", (b) =>
            b.whereIndex("idx_file_provider_key", (eb) =>
              eb.and(eb("provider", "=", input.provider), eb("key", "=", input.fileKey)),
            ),
          ),
        )
        .transformRetrieve(([file]) => {
          if (!file) {
            throw new UploadServiceError("FILE_NOT_FOUND", "The file does not exist.");
          }
          return file;
        })
        .build();
    },

    /** A ready file with the bytes it publishes. */
    getFileContent: function (this: UploadServiceContext, input: FileByKeyInput) {
      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.findFirst("file", (b) =>
            b
              .whereIndex("idx_file_provider_key", (eb) =>
                eb.and(eb("provider", "=", input.provider), eb("key", "=", input.fileKey)),
              )
              .joinOne("object", "storage_object", (object) =>
                object.onIndex("idx_storage_object_key", (eb) =>
                  eb("storageKey", "=", eb.parent("objectKey")),
                ),
              ),
          ),
        )
        .transformRetrieve(([file]) => {
          if (!file) {
            throw new UploadServiceError("FILE_NOT_FOUND", "The file does not exist.");
          }
          if (file.status === "deleted") {
            throw new UploadServiceError("FILE_DELETED", "The file has been deleted.");
          }
          const { object, ...row } = file;
          if (!object) {
            throw new Error(`File '${file.provider}:${file.key}' has no stored content.`);
          }
          return { file: row, body: object.body };
        })
        .build();
    },

    listFiles: function (this: UploadServiceContext, input: ListFilesInput) {
      const prefix = input.prefix ?? "";
      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.findWithCursor("file", (b) => {
            if (input.status && input.uploaderId) {
              const status = input.status;
              const uploaderId = input.uploaderId;
              const query = b.whereIndex("idx_file_provider_key_status_uploaderId", (eb) =>
                eb.and(
                  input.provider !== undefined
                    ? eb("provider", "=", input.provider)
                    : eb("provider", "starts with", ""),
                  eb("key", "starts with", prefix),
                  eb("status", "=", status),
                  eb("uploaderId", "=", uploaderId),
                ),
              );
              const ordered = query
                .orderByIndex("idx_file_provider_key_status_uploaderId", "asc")
                .pageSize(input.pageSize);
              return input.cursor ? ordered.after(input.cursor) : ordered;
            }

            if (input.status) {
              const status = input.status;
              const query = b.whereIndex("idx_file_provider_key_status", (eb) =>
                eb.and(
                  input.provider !== undefined
                    ? eb("provider", "=", input.provider)
                    : eb("provider", "starts with", ""),
                  eb("key", "starts with", prefix),
                  eb("status", "=", status),
                ),
              );
              const ordered = query
                .orderByIndex("idx_file_provider_key_status", "asc")
                .pageSize(input.pageSize);
              return input.cursor ? ordered.after(input.cursor) : ordered;
            }

            if (input.uploaderId) {
              const uploaderId = input.uploaderId;
              const query = b.whereIndex("idx_file_provider_key_uploaderId", (eb) =>
                eb.and(
                  input.provider !== undefined
                    ? eb("provider", "=", input.provider)
                    : eb("provider", "starts with", ""),
                  eb("key", "starts with", prefix),
                  eb("uploaderId", "=", uploaderId),
                ),
              );
              const ordered = query
                .orderByIndex("idx_file_provider_key_uploaderId", "asc")
                .pageSize(input.pageSize);
              return input.cursor ? ordered.after(input.cursor) : ordered;
            }

            const query = b.whereIndex("idx_file_provider_key", (eb) =>
              eb.and(
                input.provider !== undefined
                  ? eb("provider", "=", input.provider)
                  : eb("provider", "starts with", ""),
                eb("key", "starts with", prefix),
              ),
            );
            const ordered = query
              .orderByIndex("idx_file_provider_key", "asc")
              .pageSize(input.pageSize);
            return input.cursor ? ordered.after(input.cursor) : ordered;
          }),
        )
        .transformRetrieve(([result]) => result)
        .build();
    },

    /** Publishes every write, or none of them when a precondition fails. */
    writeFiles: function (
      this: UploadServiceContext,
      provider: string,
      writes: FileContentWrite[],
    ) {
      const fileKeys = writes.map((write) => write.fileKey);
      if (new Set(fileKeys).size !== fileKeys.length) {
        throw new UploadServiceError("INVALID_REQUEST", "A file can be written only once.");
      }

      return this.serviceTx(uploadSchema)
        .retrieve((uow) => {
          const retrieval = uow as UploadMutationUnitOfWork;
          for (const keys of chunkQueryValues(fileKeys)) {
            retrieval.find("file", (b) =>
              b
                .whereIndex("idx_file_provider_key", (eb) =>
                  eb.and(eb("provider", "=", provider), eb("key", "in", keys)),
                )
                .joinOne("object", "storage_object", (object) =>
                  object
                    .onIndex("idx_storage_object_key", (eb) =>
                      eb("storageKey", "=", eb.parent("objectKey")),
                    )
                    .select(["id"]),
                ),
            );
          }
          return retrieval as TypedUnitOfWork<
            typeof uploadSchema,
            StoredFileRow[][],
            unknown,
            UploadHooks
          >;
        })
        .mutate(({ uow, retrieveResult }) => {
          const filesByKey = new Map(retrieveResult.flat().map((file) => [file.key, file]));
          for (const write of writes) {
            assertFileWritePrecondition(
              filesByKey.get(write.fileKey) ?? null,
              write.precondition ?? undefined,
              { provider, fileKey: write.fileKey },
            );
          }

          return writes.map(({ fileKey, content, precondition: _precondition, ...file }) => {
            const objectKey = newObjectKey(provider, fileKey);
            const sizeBytes = BigInt(content.byteLength);
            uow.create("storage_object", {
              storageKey: objectKey,
              body: content,
              contentType: file.contentType,
              sizeBytes,
            });
            return publishFileContent(
              uow as UploadMutationUnitOfWork,
              filesByKey.get(fileKey) ?? null,
              { ...file, key: fileKey, provider, objectKey, sizeBytes, uploadId: null },
            );
          });
        })
        .build();
    },

    /**
     * Applies text edits to the files' current content and publishes the changed files in one
     * transaction, which fails when another write changes one of the files first.
     */
    applyFileEdits: function (
      this: UploadServiceContext,
      provider: string,
      edits: FileEditOperation[],
    ) {
      const fileKeys = Array.from(new Set(edits.map((edit) => edit.fileKey)));
      // Only files whose first edit is a replacement start from their current text.
      const readKeys = fileKeys.filter(
        (fileKey) => edits.find((edit) => edit.fileKey === fileKey)?.kind === "replace",
      );
      const overwrittenKeys = fileKeys.filter((fileKey) => !readKeys.includes(fileKey));

      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow
            .find("file", (b) =>
              b
                .whereIndex("idx_file_provider_key", (eb) =>
                  eb.and(eb("provider", "=", provider), eb("key", "in", readKeys)),
                )
                .joinOne("object", "storage_object", (object) =>
                  object.onIndex("idx_storage_object_key", (eb) =>
                    eb("storageKey", "=", eb.parent("objectKey")),
                  ),
                ),
            )
            .find("file", (b) =>
              b
                .whereIndex("idx_file_provider_key", (eb) =>
                  eb.and(eb("provider", "=", provider), eb("key", "in", overwrittenKeys)),
                )
                .joinOne("object", "storage_object", (object) =>
                  object
                    .onIndex("idx_storage_object_key", (eb) =>
                      eb("storageKey", "=", eb.parent("objectKey")),
                    )
                    .select(["id"]),
                ),
            ),
        )
        .mutate(({ uow, retrieveResult: [readFiles, overwrittenFiles] }) => {
          // Deleted files keep their rows, which a new write publishes over.
          const existingFiles = new Map<string, StoredFileRow>(
            [...readFiles, ...overwrittenFiles].map((file) => [file.key, file]),
          );
          const initialContents = new Map<string, string | null>(
            fileKeys.map((fileKey) => [fileKey, null]),
          );
          for (const file of readFiles) {
            if (file.status === "ready" && file.object) {
              initialContents.set(file.key, decodeEditedText(provider, file.key, file.object.body));
            }
          }

          const { results, finalContents } = evaluateFileEdits(provider, edits, initialContents);

          let totalChanged = 0;
          for (const fileKey of fileKeys) {
            const existing = existingFiles.get(fileKey) ?? null;
            const original = existing?.status === "ready" ? existing : null;
            const content = finalContents.get(fileKey);
            if (
              content === null ||
              content === undefined ||
              content === initialContents.get(fileKey)
            ) {
              // Unchanged files still guard the edit: it applied to the text they hold.
              if (existing) {
                uow.check("file", existing.id);
              } else {
                uow.checkAbsent("file", "idx_file_provider_key", { provider, key: fileKey });
              }
              continue;
            }

            totalChanged += 1;
            const lastEdit = edits.findLast((edit) => edit.fileKey === fileKey)!;
            const bytes = new TextEncoder().encode(content);
            assertFileSize(bytes.byteLength, config.maxFileBytes, `File '${fileKey}'`);
            const objectKey = newObjectKey(provider, fileKey);
            // TODO: Track publication metadata from the latest write/writeJson operation per file.
            // A later replace only transforms content and must not change a new JSON file's
            // content type back to text/plain.
            const contentType =
              original?.contentType ??
              (lastEdit.kind === "writeJson" ? "application/json" : "text/plain");
            uow.create("storage_object", {
              storageKey: objectKey,
              body: bytes,
              contentType,
              sizeBytes: BigInt(bytes.byteLength),
            });
            publishFileContent(uow as UploadMutationUnitOfWork, existing, {
              key: fileKey,
              provider,
              uploaderId: original?.uploaderId ?? null,
              filename: original?.filename ?? fileKey.split("/").at(-1)!,
              contentType,
              checksum: null,
              visibility: original?.visibility ?? "private",
              tags: original?.tags ?? null,
              metadata: original?.metadata ?? null,
              objectKey,
              sizeBytes: BigInt(bytes.byteLength),
              uploadId: null,
            });
          }

          return { edits: results, totalChanged };
        })
        .build();
    },

    updateFile: function (
      this: UploadServiceContext,
      fileByKey: FileByKeyInput,
      input: UpdateFileInput,
    ) {
      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.findFirst("file", (b) =>
            b.whereIndex("idx_file_provider_key", (eb) =>
              eb.and(eb("provider", "=", fileByKey.provider), eb("key", "=", fileByKey.fileKey)),
            ),
          ),
        )
        .mutate(({ uow, retrieveResult: [file] }) => {
          if (!file) {
            throw new UploadServiceError("FILE_NOT_FOUND", "The file does not exist.");
          }

          if (file.status === "deleted") {
            throw new UploadServiceError(
              "UPLOAD_INVALID_STATE",
              "Deleted file metadata cannot be updated.",
            );
          }

          const updatedFile = {
            key: file.key,
            provider: file.provider,
            uploaderId: file.uploaderId,
            filename: input.filename ?? file.filename,
            sizeBytes: file.sizeBytes,
            contentType: file.contentType,
            checksum: file.checksum,
            visibility: input.visibility ?? file.visibility,
            tags: input.tags ?? file.tags,
            metadata: input.metadata ?? file.metadata,
            status: file.status,
            errorCode: file.errorCode,
            errorMessage: file.errorMessage,
          };

          uow.update("file", file.id, (b) =>
            b
              .set({
                filename: updatedFile.filename,
                visibility: updatedFile.visibility,
                tags: updatedFile.tags,
                metadata: updatedFile.metadata,
                updatedAt: uow.now(),
              })
              .check(),
          );

          return updatedFile;
        })
        .build();
    },

    markFileDeleted: function (this: UploadServiceContext, fileByKey: FileByKeyInput) {
      return this.serviceTx(uploadSchema)
        .retrieve((uow) =>
          uow.findFirst("file", (b) =>
            b
              .whereIndex("idx_file_provider_key", (eb) =>
                eb.and(eb("provider", "=", fileByKey.provider), eb("key", "=", fileByKey.fileKey)),
              )
              .joinOne("object", "storage_object", (object) =>
                object
                  .onIndex("idx_storage_object_key", (eb) =>
                    eb("storageKey", "=", eb.parent("objectKey")),
                  )
                  .select(["id"]),
              ),
          ),
        )
        .mutate(({ uow, retrieveResult: [file] }) => {
          if (!file) {
            throw new UploadServiceError("FILE_NOT_FOUND", "The file does not exist.");
          }

          if (file.status !== "deleted") {
            deleteFileContent(uow as UploadMutationUnitOfWork, file);
          }
          return { status: "deleted" as FileStatus };
        })
        .build();
    },
  };
};
