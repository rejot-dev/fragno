import type { UploadRouteCaller } from "@/fragno/upload-server";

import { assertValidFileCollectionPath, createFileTree } from "./create-file-tree";
import {
  createUploadFileTreeEntries,
  normalizeFileCollectionPrefix,
  type UploadFileTreeRecord,
} from "./create-upload-file-tree";
import type { FileCollection, FileContent, FileTreeEntry } from "./file-collection";
import { searchUploadFiles } from "./search-upload-files";

export async function listUploadFiles(input: {
  routes: UploadRouteCaller;
  provider: string;
  prefix?: string;
  glob?: string;
  maxPages?: number;
}): Promise<UploadFileTreeRecord[]> {
  const maxPages = input.maxPages ?? 1;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new RangeError("Upload file listing maxPages must be a positive integer.");
  }

  const files: UploadFileTreeRecord[] = [];
  let cursor: string | undefined;

  for (let page = 1; page <= maxPages; page += 1) {
    const response = await input.routes("GET", "/files", {
      query: {
        provider: input.provider,
        ...(input.prefix ? { prefix: input.prefix } : {}),
        ...(input.glob ? { glob: input.glob } : {}),
        ...(cursor ? { cursor } : {}),
        pageSize: "500",
        status: "ready",
      },
    });

    if (response.type === "error") {
      throw new UploadFileListingError(response.error.message, {
        code: response.error.code,
        status: response.status,
      });
    }
    if (response.type !== "json") {
      throw new Error(
        `Upload file listing route returned an unexpected ${response.type} response.`,
      );
    }

    files.push(...response.data.files);

    if (!response.data.hasNextPage || !response.data.cursor) {
      return files;
    }
    if (page === maxPages) {
      throw new Error(`Upload file listing exceeded its ${maxPages}-page retrieval limit.`);
    }
    cursor = response.data.cursor;
  }

  return files;
}

/**
 * Creates a collection backed by the Upload fragment.
 *
 * Tree retrieval scans Upload metadata page-by-page without a delimiter. maxPages bounds the
 * number of metadata requests and defaults to one. Retrieval fails instead of returning a partial
 * tree when another page exists beyond that limit.
 *
 * Raw file bodies cannot currently be read through UploadRouteCaller because route callers parse
 * responses as JSON. The explicit getFileResponse dependency preserves streaming until raw route
 * calls are supported.
 */
export function createUploadFileCollection(input: {
  routes: UploadRouteCaller;
  provider: string;
  prefix?: string;
  maxPages?: number;
  getFileResponse(input: { provider: string; fileKey: string }): Promise<Response | null>;
}): FileCollection {
  const prefix = normalizeFileCollectionPrefix(input.prefix);
  const maxPages = input.maxPages ?? 1;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new RangeError("Upload file collection maxPages must be a positive integer.");
  }

  return {
    async getTree() {
      const files = await listUploadFiles({
        routes: input.routes,
        provider: input.provider,
        ...(prefix ? { prefix } : {}),
        maxPages,
      });
      const entries: FileTreeEntry[] = createUploadFileTreeEntries(files, {
        provider: input.provider,
        prefix,
      });
      return createFileTree(entries);
    },
    async getFile(path) {
      assertValidFileCollectionPath(path);
      return toFileContent(
        await input.getFileResponse({
          provider: input.provider,
          fileKey: `${prefix}${path}`,
        }),
      );
    },
    async searchFiles(pattern, query, options = {}, cursor) {
      const result = await searchUploadFiles({
        routes: input.routes,
        provider: input.provider,
        glob: `${prefix}${pattern.replace(/^\/+/, "")}`,
        query,
        options,
        cursor,
      });

      return {
        matches: result.matches.flatMap((match) => {
          if (!match.path.startsWith(prefix)) {
            return [];
          }
          return [{ ...match, path: match.path.slice(prefix.length) }];
        }),
        ...(result.cursor ? { cursor: result.cursor } : {}),
        hasMore: result.hasMoreCandidates,
      };
    },
  };
}

async function toFileContent(response: Response | null): Promise<FileContent | null> {
  if (response === null || response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const fallbackMessage = `Upload file content request failed with HTTP ${response.status}.`;
    let payload: unknown;

    try {
      payload = await response.json();
    } catch (cause) {
      throw new UploadFileCollectionError(fallbackMessage, {
        code: `HTTP_${response.status}`,
        status: response.status,
        cause,
      });
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new UploadFileCollectionError(fallbackMessage, {
        code: `HTTP_${response.status}`,
        status: response.status,
      });
    }

    const error = payload as Record<string, unknown>;
    throw new UploadFileCollectionError(
      typeof error.message === "string" && error.message.trim() ? error.message : fallbackMessage,
      {
        code:
          typeof error.code === "string" && error.code.trim()
            ? error.code
            : `HTTP_${response.status}`,
        status: response.status,
      },
    );
  }

  if (!response.body) {
    throw new UploadFileCollectionError("Upload file content response has no body.", {
      code: "UPLOAD_FILE_BODY_MISSING",
      status: response.status,
    });
  }

  const contentLength = response.headers.get("content-length");
  const sizeBytes = contentLength === null ? null : Number(contentLength);

  return {
    body: response.body,
    contentType: response.headers.get("content-type"),
    sizeBytes: sizeBytes !== null && Number.isFinite(sizeBytes) ? sizeBytes : null,
  };
}

class UploadFileListingError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, options: { code: string; status: number }) {
    super(message);
    this.name = "UploadFileListingError";
    this.code = options.code;
    this.status = options.status;
  }
}

class UploadFileCollectionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, options: { code: string; status: number; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "UploadFileCollectionError";
    this.code = options.code;
    this.status = options.status;
  }
}
