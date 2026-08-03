import { assertValidFileCollectionPath, createFileTree } from "./create-file-tree";
import {
  createUploadFileTreeEntries,
  normalizeFileCollectionPrefix,
  type UploadFileTreeRecord,
} from "./create-upload-file-tree";
import type { FileCollection, FileContent, FileTreeEntry } from "./file-collection";

type UploadFilesRouteResponse =
  | {
      type: "json";
      status: number;
      data: {
        files: UploadFileTreeRecord[];
        cursor?: string;
        hasNextPage: boolean;
      };
    }
  | {
      type: "error";
      status: number;
      error: {
        message: string;
        code: string;
      };
    }
  | { type: "empty"; status: number }
  | { type: "jsonStream"; status: number };

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
  routes(
    method: "GET",
    path: "/files",
    options: {
      query: {
        provider: string;
        prefix?: string;
        cursor?: string;
        pageSize: string;
        status: "ready";
      };
    },
  ): Promise<UploadFilesRouteResponse>;
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
      const entries: FileTreeEntry[] = [];
      let cursor: string | undefined;

      for (let page = 1; page <= maxPages; page += 1) {
        const response = await input.routes("GET", "/files", {
          query: {
            provider: input.provider,
            ...(prefix ? { prefix } : {}),
            ...(cursor ? { cursor } : {}),
            pageSize: "500",
            status: "ready",
          },
        });

        if (response.type === "error") {
          throw new UploadFileCollectionError(response.error.message, {
            code: response.error.code,
            status: response.status,
          });
        }
        if (response.type !== "json") {
          throw new Error(
            `Upload file tree route returned an unexpected ${response.type} response.`,
          );
        }

        entries.push(
          ...createUploadFileTreeEntries(response.data.files, {
            provider: input.provider,
            prefix,
          }),
        );

        if (!response.data.hasNextPage || !response.data.cursor) {
          break;
        }
        if (page === maxPages) {
          throw new Error(`Upload file tree exceeded its ${maxPages}-page retrieval limit.`);
        }
        cursor = response.data.cursor;
      }

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
