import { createTarDecoder, createTarPacker, type ParsedTarEntry } from "modern-tar";
import { z } from "zod";

import { defineRoutes, type FragnoRouteConfig } from "@fragno-dev/core";
import type { DatabaseHandlerTx } from "@fragno-dev/db";

import { resolveUploadFragmentConfig } from "../config";
import { uploadFragmentDefinition } from "../definition";
import {
  fileLinkGlobBase,
  fileLinkGlobMatches,
  isFileLinkGlob,
  resolveFileLinkGlobKey,
  signFileLink,
  verifyFileLink,
  type FileLinkAccess,
  type FileLinkGrant,
  type FileLinksConfig,
} from "../file-links";
import { UploadServiceError } from "../services/errors";
import { resolveFileKeyInput } from "../services/helpers";
import type { InitializedUpload } from "../services/upload-model";
import { MAX_PREPARED_FILE_BATCH_ENTRIES } from "../services/uploads";
import { buildStorageObjectVersionSegment } from "../storage/object-key";
import type { StorageAdapter } from "../storage/types";
import { providerNamespaceSchema } from "./shared";
import { handleUploadServiceError } from "./uploads-errors";
import { mapStorageOperationError } from "./uploads-storage";

const MAX_FILE_LINK_LIFETIME_SECONDS = 60 * 60;
// A downloaded archive is one listing page, so each request reads a bounded number of files.
const MAX_FILE_LINK_ARCHIVE_PAGE_FILES = 500;
const FILE_LINK_NEXT_CURSOR_HEADER = "X-Next-Cursor";

const fileLinkErrorCodes = [
  "FILE_LINKS_DISABLED",
  "FILE_LINK_INVALID",
  "FILE_LINK_EXPIRED",
  "FILE_LINK_FORBIDDEN",
  "FILE_NOT_FOUND",
  "FILE_DELETED",
  "FILE_ALREADY_EXISTS",
  "FILE_PRECONDITION_FAILED",
  "UPLOAD_NOT_FOUND",
  "UPLOAD_EXPIRED",
  "UPLOAD_INVALID_STATE",
  "PROVIDER_MISMATCH",
  "INVALID_FILE_KEY",
  "INVALID_CHECKSUM",
  "INVALID_REQUEST",
  "STORAGE_ERROR",
] as const;

type FileLinkErrorCode = (typeof fileLinkErrorCodes)[number];

type FileLinkRouteError = Parameters<
  FragnoRouteConfig<"GET", "/__error", undefined, undefined, FileLinkErrorCode>["handler"]
>[1]["error"];

class FileLinkRequestError extends Error {
  constructor(
    readonly code: FileLinkErrorCode,
    message: string,
    readonly status: 400 | 403 | 410 | 411 | 413,
  ) {
    super(message);
  }
}

const createFileLinkInputSchema = z.object({
  provider: providerNamespaceSchema,
  access: z.enum(["read", "write"]),
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("file"), fileKey: z.string().min(1) }),
    z.object({ kind: z.literal("glob"), glob: z.string().min(1).max(512) }),
  ]),
  expiresInSeconds: z.number().int().min(1).max(MAX_FILE_LINK_LIFETIME_SECONDS),
});

// A count rather than a file list: clients such as curl print the response, and an archive may hold
// thousands of files.
const publishedLinkWritesSchema = z.object({
  fileCount: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
});

type LinkWrite = { fileKey: string; sizeBytes: number; body: ReadableStream<Uint8Array> };
type StagedLinkWrite = {
  fileKey: string;
  sizeBytes: number;
  contentType: string;
  storageInit: InitializedUpload;
};

function requireFileLinks(config: FileLinksConfig | undefined): FileLinksConfig {
  if (!config) {
    throw new FileLinkRequestError(
      "FILE_LINKS_DISABLED",
      "File links are not configured for this upload instance.",
      400,
    );
  }
  return config;
}

async function authorizeFileLink(
  config: FileLinksConfig | undefined,
  storage: StorageAdapter,
  token: string,
  access: FileLinkAccess,
): Promise<{ grant: FileLinkGrant; links: FileLinksConfig }> {
  const links = requireFileLinks(config);
  const verification = await verifyFileLink(links, token, Date.now());
  if (verification.status === "expired") {
    throw new FileLinkRequestError("FILE_LINK_EXPIRED", "The file link has expired.", 410);
  }
  if (verification.status === "invalid" || verification.grant.provider !== storage.name) {
    throw new FileLinkRequestError("FILE_LINK_INVALID", "The file link is invalid.", 403);
  }
  if (verification.grant.access !== access) {
    throw new FileLinkRequestError(
      "FILE_LINK_FORBIDDEN",
      `The file link does not grant ${access} access.`,
      403,
    );
  }
  return { grant: verification.grant, links };
}

function requireFileTarget(grant: FileLinkGrant): string {
  if (grant.target.kind !== "file") {
    throw new FileLinkRequestError(
      "INVALID_REQUEST",
      "This link addresses a glob; use its archive.tar endpoint.",
      400,
    );
  }
  return grant.target.fileKey;
}

function requireGlobTarget(grant: FileLinkGrant): string {
  if (grant.target.kind !== "glob") {
    throw new FileLinkRequestError(
      "INVALID_REQUEST",
      "This link addresses one file; use the link itself.",
      400,
    );
  }
  return grant.target.glob;
}

async function stageLinkWrite(
  storage: StorageAdapter,
  links: FileLinksConfig,
  maxFileBytes: number | undefined,
  write: LinkWrite,
): Promise<StagedLinkWrite> {
  // Storage adapters reject oversized objects only as generic storage failures.
  if (maxFileBytes !== undefined && write.sizeBytes > maxFileBytes) {
    throw new FileLinkRequestError(
      "INVALID_REQUEST",
      `File '${write.fileKey}' is ${write.sizeBytes} bytes; files may be at most ${maxFileBytes} bytes.`,
      413,
    );
  }
  const contentType = links.contentTypeForKey(write.fileKey);
  let storageInit: InitializedUpload | null = null;
  try {
    storageInit = await storage.initUpload({
      provider: storage.name,
      fileKey: write.fileKey,
      sizeBytes: BigInt(write.sizeBytes),
      contentType,
      checksum: null,
      metadata: null,
      objectKeyVersionSegment: buildStorageObjectVersionSegment(),
    });
    if (storageInit.strategy !== "proxy" || !storage.writeStream) {
      if (storageInit.storageUploadId && storage.abortMultipartUpload) {
        await storage.abortMultipartUpload({
          storageKey: storageInit.storageKey,
          storageUploadId: storageInit.storageUploadId,
        });
      }
      throw new UploadServiceError("STORAGE_ERROR", "File links require proxy upload storage.");
    }
    await storage.writeStream({
      storageKey: storageInit.storageKey,
      body: write.body,
      contentType,
      sizeBytes: BigInt(write.sizeBytes),
    });
    if (storage.finalizeUpload) {
      await storage.finalizeUpload({
        storageKey: storageInit.storageKey,
        expectedSizeBytes: BigInt(write.sizeBytes),
        checksum: null,
      });
    }
    return { fileKey: write.fileKey, sizeBytes: write.sizeBytes, contentType, storageInit };
  } catch (cause) {
    // No upload record tracks this object yet, so nothing else would delete it.
    if (storageInit) {
      const storageKey = storageInit.storageKey;
      await Promise.allSettled([storage.deleteObject({ storageKey })]);
    }
    // A malformed request body surfaces while storage reads it, but is not a storage failure.
    throw cause instanceof FileLinkRequestError ? cause : mapStorageOperationError(cause);
  }
}

/** Stages every write in storage first, so a rejected archive publishes none of its files. */
async function stageLinkWrites(
  storage: StorageAdapter,
  links: FileLinksConfig,
  maxFileBytes: number | undefined,
  writes: AsyncIterable<LinkWrite>,
): Promise<StagedLinkWrite[]> {
  const staged: StagedLinkWrite[] = [];
  try {
    for await (const write of writes) {
      staged.push(await stageLinkWrite(storage, links, maxFileBytes, write));
    }
    return staged;
  } catch (cause) {
    await Promise.allSettled(
      staged.map(({ storageInit }) => storage.deleteObject({ storageKey: storageInit.storageKey })),
    );
    throw cause;
  }
}

function normalizeArchiveEntryPath(name: string): string | null {
  const path = name.replace(/^(?:\.\/)+/u, "");
  return path.length === 0 || path.startsWith("/") ? null : path;
}

/** Reports a truncated or corrupt entry body as a client error rather than a storage failure. */
function rejectUnreadableEntry(
  body: ReadableStream<Uint8Array>,
  name: string,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (cause) {
        throw new FileLinkRequestError(
          "INVALID_REQUEST",
          `Archive entry '${name}' is unreadable: ${cause instanceof Error ? cause.message : String(cause)}`,
          400,
        );
      }
      if (next.done) {
        controller.close();
      } else {
        controller.enqueue(next.value);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

async function* archiveWrites(
  body: ReadableStream<Uint8Array>,
  glob: string,
  links: FileLinksConfig,
): AsyncGenerator<LinkWrite> {
  const reader = body.pipeThrough(createTarDecoder({ strict: true })).getReader();
  const maxFiles = Math.min(links.maxArchiveWriteFiles, MAX_PREPARED_FILE_BATCH_ENTRIES);
  const fileKeys = new Set<string>();
  let sizeBytes = 0;
  try {
    while (true) {
      let next: ReadableStreamReadResult<ParsedTarEntry>;
      try {
        next = await reader.read();
      } catch (cause) {
        throw new FileLinkRequestError(
          "INVALID_REQUEST",
          `The request body is not a readable tar archive: ${cause instanceof Error ? cause.message : String(cause)}`,
          400,
        );
      }
      if (next.done) {
        return;
      }
      const { header, body: entryBody } = next.value;
      if (header.type === "directory") {
        await entryBody.cancel();
        continue;
      }
      if (header.type !== "file") {
        await entryBody.cancel();
        throw new FileLinkRequestError(
          "INVALID_REQUEST",
          `Archive entry '${header.name}' is a ${header.type}; only files and directories are accepted, so archive links with 'tar -h'.`,
          400,
        );
      }
      const relativePath = normalizeArchiveEntryPath(header.name);
      const fileKey = relativePath === null ? null : resolveFileLinkGlobKey(glob, relativePath);
      if (fileKey === null) {
        await entryBody.cancel();
        throw new FileLinkRequestError(
          "FILE_LINK_FORBIDDEN",
          `Archive entry '${header.name}' is outside the link's glob '${glob}'.`,
          403,
        );
      }
      if (fileKeys.has(fileKey)) {
        await entryBody.cancel();
        throw new FileLinkRequestError(
          "INVALID_REQUEST",
          `Archive entry '${header.name}' appears more than once.`,
          400,
        );
      }
      sizeBytes += header.size;
      if (fileKeys.size === maxFiles || sizeBytes > links.maxArchiveWriteBytes) {
        await entryBody.cancel();
        throw new FileLinkRequestError(
          "INVALID_REQUEST",
          `Archives may contain at most ${maxFiles} files and ${links.maxArchiveWriteBytes} bytes; upload only the files you need.`,
          400,
        );
      }
      fileKeys.add(fileKey);
      yield {
        fileKey,
        sizeBytes: header.size,
        body: rejectUnreadableEntry(entryBody, header.name),
      };
    }
  } finally {
    reader.releaseLock();
  }
}

async function* singleWrite(write: LinkWrite): AsyncGenerator<LinkWrite> {
  yield write;
}

function requireContentLength(headers: Headers): number {
  const contentLength = headers.get("content-length");
  const sizeBytes = Number(contentLength);
  if (!contentLength?.trim() || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new FileLinkRequestError(
      "INVALID_REQUEST",
      "A valid Content-Length header is required.",
      411,
    );
  }
  return sizeBytes;
}

export const fileLinkRoutesFactory = defineRoutes(uploadFragmentDefinition).create(
  ({ services, defineRoute, config }) => {
    const getResolvedConfig = () => resolveUploadFragmentConfig(config);

    function toErrorResponse(cause: unknown, error: FileLinkRouteError): Response {
      if (cause instanceof FileLinkRequestError) {
        return error({ message: cause.message, code: cause.code }, cause.status);
      }
      if (cause instanceof UploadServiceError) {
        return handleUploadServiceError(cause, error);
      }
      throw cause;
    }

    /** Publishes staged writes as one batch, replacing any files at their keys. */
    async function publishLinkWrites(
      handlerTx: DatabaseHandlerTx,
      provider: string,
      staged: StagedLinkWrite[],
    ) {
      const published = {
        fileCount: staged.length,
        sizeBytes: staged.reduce((total, write) => total + write.sizeBytes, 0),
      };
      if (staged.length === 0) {
        return published;
      }
      // TODO: Like file edits, staged objects survive database errors because the commit may have
      // succeeded even when its acknowledgement was lost.
      const prepared = await handlerTx()
        .withServiceCalls(() => [
          services.createPreparedFileUploads(
            staged.map((write) => ({
              provider,
              fileKey: write.fileKey,
              filename: write.fileKey.split("/").at(-1)!,
              sizeBytes: write.sizeBytes,
              contentType: write.contentType,
              checksum: null,
              publicationMode: "batch",
              storageInit: write.storageInit,
              completedSizeBytes: BigInt(write.sizeBytes),
            })),
          ),
        ])
        .transform(({ serviceResult: [uploads] }) => uploads)
        .execute();
      await handlerTx()
        .withServiceCalls(() => [
          services.commitPreparedFileWrites({
            entries: prepared.map((upload) => ({ kind: "write", uploadId: upload.uploadId })),
            activeProvider: provider,
          }),
        ])
        .execute();
      return published;
    }

    return [
      defineRoute({
        method: "POST",
        path: "/file-links",
        inputSchema: createFileLinkInputSchema,
        outputSchema: z.object({ token: z.string(), expiresAt: z.date() }),
        errorCodes: fileLinkErrorCodes,
        handler: async function createFileLink({ input }, { json, error }) {
          const payload = await input.valid();
          const resolvedConfig = getResolvedConfig();
          try {
            const links = requireFileLinks(resolvedConfig.fileLinks);
            if (payload.provider !== resolvedConfig.storage.name) {
              throw new UploadServiceError(
                "PROVIDER_MISMATCH",
                "The link provider does not match the active storage provider.",
              );
            }
            if (payload.target.kind === "glob" && !isFileLinkGlob(payload.target.glob)) {
              throw new FileLinkRequestError(
                "INVALID_REQUEST",
                "A glob link needs a relative glob with a * or ? wildcard; link one file by its key instead.",
                400,
              );
            }
            const target =
              payload.target.kind === "file"
                ? {
                    kind: "file" as const,
                    fileKey: resolveFileKeyInput({ fileKey: payload.target.fileKey }).fileKey,
                  }
                : payload.target;
            const expiresAtEpochMs = Date.now() + payload.expiresInSeconds * 1000;
            const token = await signFileLink(links, {
              provider: payload.provider,
              access: payload.access,
              target,
              expiresAtEpochMs,
            });
            return json({ token, expiresAt: new Date(expiresAtEpochMs) });
          } catch (cause) {
            return toErrorResponse(cause, error);
          }
        },
      }),

      defineRoute({
        method: "GET",
        path: "/file-links/:token",
        errorCodes: fileLinkErrorCodes,
        handler: async function readLinkedFile({ pathParams }, { error }) {
          const { storage, fileLinks } = getResolvedConfig();
          try {
            const { grant } = await authorizeFileLink(fileLinks, storage, pathParams.token, "read");
            const file = await this.handlerTx()
              .withServiceCalls(() => [
                services.getFileByKey({
                  provider: grant.provider,
                  fileKey: requireFileTarget(grant),
                }),
              ])
              .transform(({ serviceResult: [result] }) => result)
              .execute();
            if (file.status === "deleted") {
              throw new UploadServiceError("FILE_DELETED", "The file has been deleted.");
            }
            if (!storage.getDownloadStream) {
              throw new UploadServiceError("STORAGE_ERROR", "Download streaming unsupported.");
            }
            try {
              return await storage.getDownloadStream({ storageKey: file.objectKey });
            } catch (cause) {
              throw mapStorageOperationError(cause);
            }
          } catch (cause) {
            return toErrorResponse(cause, error);
          }
        },
      }),

      defineRoute({
        method: "PUT",
        path: "/file-links/:token",
        contentType: "application/octet-stream",
        outputSchema: publishedLinkWritesSchema,
        errorCodes: fileLinkErrorCodes,
        handler: async function writeLinkedFile(context, { json, error }) {
          const { storage, fileLinks, maxSingleUploadBytes } = getResolvedConfig();
          try {
            const { grant, links } = await authorizeFileLink(
              fileLinks,
              storage,
              context.pathParams.token,
              "write",
            );
            const staged = await stageLinkWrites(
              storage,
              links,
              maxSingleUploadBytes,
              singleWrite({
                fileKey: requireFileTarget(grant),
                sizeBytes: requireContentLength(context.headers),
                body: context.bodyStream(),
              }),
            );
            return json(
              await publishLinkWrites((options) => this.handlerTx(options), grant.provider, staged),
            );
          } catch (cause) {
            return toErrorResponse(cause, error);
          }
        },
      }),

      defineRoute({
        method: "GET",
        path: "/file-links/:token/archive.tar",
        queryParameters: ["cursor"],
        errorCodes: fileLinkErrorCodes,
        handler: async function readLinkedArchive({ pathParams, query }, { error }) {
          const { storage, fileLinks } = getResolvedConfig();
          try {
            const { grant } = await authorizeFileLink(fileLinks, storage, pathParams.token, "read");
            const glob = requireGlobTarget(grant);
            const getDownloadStream = storage.getDownloadStream?.bind(storage);
            if (!getDownloadStream) {
              throw new UploadServiceError("STORAGE_ERROR", "Download streaming unsupported.");
            }
            const base = fileLinkGlobBase(glob);
            const page = await this.handlerTx()
              .withServiceCalls(() => [
                services.listFiles({
                  provider: grant.provider,
                  prefix: base,
                  pageSize: MAX_FILE_LINK_ARCHIVE_PAGE_FILES,
                  cursor: query.get("cursor") || undefined,
                  status: "ready",
                }),
              ])
              .transform(({ serviceResult: [result] }) => result)
              .execute();
            const files = page.items.filter((file) => fileLinkGlobMatches(glob, file.key));

            const { readable, controller } = createTarPacker();
            void (async () => {
              for (const file of files) {
                const content = await getDownloadStream({ storageKey: file.objectKey });
                if (!content.ok || !content.body) {
                  throw new Error(`Storage could not read '${file.key}' (${content.status}).`);
                }
                await content.body.pipeTo(
                  controller.add({
                    name: file.key.slice(base.length),
                    size: Number(file.sizeBytes),
                    type: "file",
                    mtime: file.updatedAt,
                  }),
                );
              }
              controller.finalize();
            })().catch((cause: unknown) => {
              controller.error(cause);
            });

            const headers = new Headers({ "Content-Type": "application/x-tar" });
            const nextCursor = page.hasNextPage ? page.cursor?.encode() : undefined;
            if (nextCursor) {
              headers.set(FILE_LINK_NEXT_CURSOR_HEADER, nextCursor);
            }
            return new Response(readable, { headers });
          } catch (cause) {
            return toErrorResponse(cause, error);
          }
        },
      }),

      defineRoute({
        method: "PUT",
        path: "/file-links/:token/archive.tar",
        contentType: "application/octet-stream",
        outputSchema: publishedLinkWritesSchema,
        errorCodes: fileLinkErrorCodes,
        handler: async function writeLinkedArchive(context, { json, error }) {
          const { storage, fileLinks, maxSingleUploadBytes } = getResolvedConfig();
          try {
            const { grant, links } = await authorizeFileLink(
              fileLinks,
              storage,
              context.pathParams.token,
              "write",
            );
            const staged = await stageLinkWrites(
              storage,
              links,
              maxSingleUploadBytes,
              archiveWrites(context.bodyStream(), requireGlobTarget(grant), links),
            );
            return json(
              await publishLinkWrites((options) => this.handlerTx(options), grant.provider, staged),
            );
          } catch (cause) {
            return toErrorResponse(cause, error);
          }
        },
      }),
    ];
  },
);
