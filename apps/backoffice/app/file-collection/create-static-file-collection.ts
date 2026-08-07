import { searchTextContent, shouldIndexContentType } from "@fragno-dev/upload/text-index";

import { createFileTree } from "./create-file-tree";
import type { FileCollection, FileSearchMatch, FileTreeEntry } from "./file-collection";

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
    async search(query, options = {}) {
      const maxMatches = options.maxMatches ?? 50;
      const matches: FileSearchMatch[] = [];

      for (const [path, file] of contents) {
        if (matches.length >= maxMatches || !shouldIndexContentType(file.contentType)) {
          continue;
        }

        const text =
          typeof file.content === "string"
            ? file.content
            : new TextDecoder("utf-8", { fatal: false }).decode(file.content);
        matches.push(
          ...searchTextContent(path, text, query, {
            ...options,
            maxMatches: maxMatches - matches.length,
          }),
        );
      }

      return matches;
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
