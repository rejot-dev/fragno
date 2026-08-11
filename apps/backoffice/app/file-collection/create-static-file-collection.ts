import {
  globToRegExp,
  searchTextContent,
  shouldIndexContentType,
} from "@fragno-dev/upload/text-index";
import { z } from "zod";

import { createFileTree } from "./create-file-tree";
import {
  createFileSearchFingerprint,
  type FileCollection,
  type FileSearchMatch,
  type FileTreeEntry,
} from "./file-collection";

const staticFileSearchCursorSchema = z.object({
  version: z.literal(1),
  fingerprint: z.string(),
  offset: z.number().int().nonnegative(),
});

/**
 * Creates a collection whose tree and contents are both held in memory.
 */
export function createStaticFileCollection(
  files: Readonly<
    Record<
      string,
      | string
      | Uint8Array
      | {
          content: string | Uint8Array;
          displayName?: string;
          contentType?: string;
          updatedAt?: string;
          metadata?: Record<string, unknown>;
          contentVersion?: string;
        }
    >
  >,
): FileCollection {
  const entries: FileTreeEntry[] = [];
  const contents = new Map<
    string,
    {
      content: string | Uint8Array;
      contentType: string;
      sizeBytes: number;
    }
  >();

  for (const [path, definition] of Object.entries(files)) {
    const file =
      typeof definition === "string" || definition instanceof Uint8Array
        ? { content: definition }
        : definition;
    const contentType = file.contentType ?? inferContentType(path);
    const sizeBytes =
      typeof file.content === "string"
        ? new TextEncoder().encode(file.content).byteLength
        : file.content.byteLength;

    entries.push({
      kind: "file",
      path,
      ...(file.displayName ? { displayName: file.displayName } : {}),
      sizeBytes,
      contentType,
      updatedAt: file.updatedAt ?? null,
      metadata: file.metadata ?? null,
      ...(file.contentVersion ? { contentVersion: file.contentVersion } : {}),
    });
    contents.set(path, { content: file.content, contentType, sizeBytes });
  }

  const tree = createFileTree(entries);

  return {
    async getTree() {
      return tree;
    },
    async getFile(path) {
      const file = contents.get(path);
      if (!file) {
        return null;
      }

      const body =
        typeof file.content === "string" ? file.content : new Uint8Array(file.content).buffer;

      return {
        body: new Blob([body]).stream(),
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
      };
    },
    async searchFiles(pattern, query, options = {}, cursor) {
      const maxMatches = options.maxMatches ?? 50;
      if (maxMatches <= 0 || query.length === 0) {
        return { matches: [], hasMore: false };
      }

      const fingerprint = createFileSearchFingerprint(pattern, query, options);
      let offset = 0;
      if (cursor !== undefined) {
        try {
          const position = staticFileSearchCursorSchema.parse(
            JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
          );
          if (position.fingerprint !== fingerprint) {
            throw new Error("Search changed.");
          }
          offset = position.offset;
        } catch {
          throw new Error("Invalid static file search cursor.");
        }
      }

      const expression = globToRegExp(pattern);
      const matches: FileSearchMatch[] = [];
      const matchingFiles = [...contents]
        .filter(([path, file]) => expression.test(path) && shouldIndexContentType(file.contentType))
        .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath));
      const searchLimit = offset + maxMatches + 1;

      for (const [path, file] of matchingFiles) {
        if (matches.length >= searchLimit) {
          break;
        }
        const text =
          typeof file.content === "string"
            ? file.content
            : new TextDecoder("utf-8", { fatal: false }).decode(file.content);
        const lines = text.split(/\r?\n/);
        matches.push(
          ...searchTextContent(path, text, query, {
            ...options,
            maxMatches: searchLimit - matches.length,
          }).map((match) => ({
            ...match,
            lineText: lines[match.line - 1] ?? "",
          })),
        );
      }

      const pageMatches = matches.slice(offset, offset + maxMatches);
      const hasMore = matches.length > offset + pageMatches.length;
      return {
        matches: pageMatches,
        ...(hasMore
          ? {
              cursor: Buffer.from(
                JSON.stringify({
                  version: 1,
                  fingerprint,
                  offset: offset + pageMatches.length,
                }),
              ).toString("base64url"),
            }
          : {}),
        hasMore,
      };
    },
  };
}

function inferContentType(path: string): string {
  const lowerPath = path.toLowerCase();

  if (lowerPath.endsWith(".md") || lowerPath.endsWith(".mdx")) {
    return "text/markdown";
  }
  if (lowerPath.endsWith(".json")) {
    return "application/json";
  }
  if (lowerPath.endsWith(".js") || lowerPath.endsWith(".jsx")) {
    return "text/javascript";
  }
  if (lowerPath.endsWith(".ts") || lowerPath.endsWith(".tsx")) {
    return "text/typescript";
  }
  if (lowerPath.endsWith(".html")) {
    return "text/html";
  }
  if (lowerPath.endsWith(".css")) {
    return "text/css";
  }
  if (lowerPath.endsWith(".yaml") || lowerPath.endsWith(".yml")) {
    return "application/yaml";
  }
  if (lowerPath.endsWith(".txt") || lowerPath.endsWith(".log")) {
    return "text/plain";
  }

  return "application/octet-stream";
}
