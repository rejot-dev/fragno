import { createTarDecoder, createTarPacker, type ParsedTarEntry } from "modern-tar";
import { z } from "zod";

import { defineRoutes, type FragnoRouteConfig } from "@fragno-dev/core";

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
import { assertFileSize, readContent } from "../services/content";
import { UploadServiceError } from "../services/errors";
import type { FileContentWrite } from "../services/files";
import { resolveFileKeyInput } from "../services/helpers";
import { MAX_PREPARED_FILE_BATCH_ENTRIES } from "../services/uploads";
import { handleUploadServiceError } from "./uploads-errors";

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
  "FILE_PRECONDITION_FAILED",
  "FILE_TOO_LARGE",
  "INVALID_FILE_KEY",
  "INVALID_REQUEST",
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
  token: string,
  access: FileLinkAccess,
): Promise<{ grant: FileLinkGrant; links: FileLinksConfig }> {
  const links = requireFileLinks(config);
  const verification = await verifyFileLink(links, token, Date.now());
  if (verification.status === "expired") {
    throw new FileLinkRequestError("FILE_LINK_EXPIRED", "The file link has expired.", 410);
  }
  if (verification.status === "invalid") {
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

/** Reads every write's content first, so a rejected archive publishes none of its files. */
async function readLinkWrites(
  links: FileLinksConfig,
  maxFileBytes: number,
  writes: AsyncIterable<LinkWrite>,
): Promise<FileContentWrite[]> {
  const contents: FileContentWrite[] = [];
  for await (const write of writes) {
    const name = `File '${write.fileKey}'`;
    assertFileSize(write.sizeBytes, maxFileBytes, name);
    contents.push({
      fileKey: write.fileKey,
      content: await readContent(write.body, maxFileBytes, name),
      filename: write.fileKey.split("/").at(-1)!,
      contentType: links.contentTypeForKey(write.fileKey),
      checksum: null,
      visibility: "private",
      tags: null,
      metadata: null,
      uploaderId: null,
      precondition: null,
    });
  }
  return contents;
}

function normalizeArchiveEntryPath(name: string): string | null {
  const path = name.replace(/^(?:\.\/)+/u, "");
  return path.length === 0 || path.startsWith("/") ? null : path;
}

/** Reports a truncated or corrupt entry body as a client error rather than a server failure. */
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

/**
 * Link holders open these responses in browsers on the host's origin, so they always download, and
 * a linked HTML or SVG file that is opened anyway runs no scripts there.
 */
function linkedDownload(body: BodyInit | null, headers: Headers, filename: string): Response {
  // RFC 5987 values exclude the characters encodeURIComponent keeps, and browsers drop the
  // whole filename* on an unescaped apostrophe.
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  headers.set(
    "Content-Disposition",
    `attachment; filename="${filename.replace(/[^\x20-\x7e]|["\\]/gu, "_")}"; filename*=UTF-8''${encoded}`,
  );
  headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(body, { headers });
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
    function toErrorResponse(cause: unknown, error: FileLinkRouteError): Response {
      if (cause instanceof FileLinkRequestError) {
        return error({ message: cause.message, code: cause.code }, cause.status);
      }
      if (cause instanceof UploadServiceError) {
        return handleUploadServiceError(cause, error);
      }
      throw cause;
    }

    function summarizeLinkWrites(writes: FileContentWrite[]) {
      return {
        fileCount: writes.length,
        sizeBytes: writes.reduce((total, write) => total + write.content.byteLength, 0),
      };
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
          try {
            const links = requireFileLinks(config.fileLinks);
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
          try {
            const { grant } = await authorizeFileLink(config.fileLinks, pathParams.token, "read");
            const { file, body } = await this.handlerTx()
              .withServiceCalls(() => [
                services.getFileContent({
                  fileKey: requireFileTarget(grant),
                }),
              ])
              .transform(({ serviceResult: [result] }) => result)
              .execute();
            return linkedDownload(
              body.slice(),
              new Headers({
                "Content-Type": file.contentType,
                "Content-Length": String(body.byteLength),
              }),
              file.filename,
            );
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
          try {
            const { grant, links } = await authorizeFileLink(
              config.fileLinks,
              context.pathParams.token,
              "write",
            );
            const writes = await readLinkWrites(
              links,
              config.maxFileBytes,
              singleWrite({
                fileKey: requireFileTarget(grant),
                sizeBytes: requireContentLength(context.headers),
                body: context.bodyStream(),
              }),
            );
            await this.handlerTx()
              .withServiceCalls(() => [services.writeFiles(writes)])
              .execute();
            return json(summarizeLinkWrites(writes));
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
          try {
            const { grant } = await authorizeFileLink(config.fileLinks, pathParams.token, "read");
            const glob = requireGlobTarget(grant);
            const base = fileLinkGlobBase(glob);
            const page = await this.handlerTx()
              .withServiceCalls(() => [
                services.listFiles({
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
              // One read per file, as the downloader consumes the archive, so the archive never
              // holds a page of files in memory.
              for (const file of files) {
                const content = await this.handlerTx()
                  .withServiceCalls(() => [services.getFileContent({ fileKey: file.key })])
                  .transform(({ serviceResult: [result] }) => result)
                  .execute();
                const entry = controller.add({
                  name: file.key.slice(base.length),
                  size: content.body.byteLength,
                  type: "file",
                  mtime: content.file.updatedAt,
                });
                await new Blob([content.body.slice()]).stream().pipeTo(entry);
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
            const folder = base.split("/").at(-2);
            return linkedDownload(readable, headers, `${folder || "archive"}.tar`);
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
          try {
            const { grant, links } = await authorizeFileLink(
              config.fileLinks,
              context.pathParams.token,
              "write",
            );
            const writes = await readLinkWrites(
              links,
              config.maxFileBytes,
              archiveWrites(context.bodyStream(), requireGlobTarget(grant), links),
            );
            if (writes.length > 0) {
              await this.handlerTx()
                .withServiceCalls(() => [services.writeFiles(writes)])
                .execute();
            }
            return json(summarizeLinkWrites(writes));
          } catch (cause) {
            return toErrorResponse(cause, error);
          }
        },
      }),
    ];
  },
);
