/**
 * A read-only collection of files below the mount layer.
 *
 * The tree and file contents are deliberately independent. A caller may retrieve both from the
 * same collection, or provide a tree it already owns locally while retaining a remote content
 * reader.
 *
 * Paths are relative to the collection root. The root itself is implicit.
 */

export type FileTreeEntry =
  | {
      kind: "directory";
      path: string;
      displayName?: string;
      updatedAt: string | null;
      metadata: Record<string, unknown> | null;
    }
  | {
      kind: "file";
      path: string;
      displayName?: string;
      sizeBytes: number | null;
      contentType: string | null;
      updatedAt: string | null;
      metadata: Record<string, unknown> | null;
      contentVersion?: string;
    };

export type FileTree = {
  entries: readonly FileTreeEntry[];
};

export interface FileContent {
  body: ReadableStream<Uint8Array>;
  contentType: string | null;
  sizeBytes: number | null;
}

export type FileSearchOptions = {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  contextBefore?: number;
  contextAfter?: number;
  maxMatches?: number;
};

export const createFileSearchFingerprint = (
  pattern: string,
  query: string,
  options: FileSearchOptions,
): string =>
  JSON.stringify({
    pattern,
    query,
    caseSensitive: options.caseSensitive ?? false,
    wholeWord: options.wholeWord ?? false,
    contextBefore: options.contextBefore ?? 0,
    contextAfter: options.contextAfter ?? 0,
  });

export type FileSearchMatch = {
  path: string;
  line: number;
  column: number;
  text: string;
  lineText: string;
  contextBefore: readonly string[];
  contextAfter: readonly string[];
};

export type FileSearchPage = {
  matches: readonly FileSearchMatch[];
  cursor?: string;
  hasMore: boolean;
};

export interface FileTreeReader {
  getTree(): Promise<FileTree>;
  searchFiles(
    pattern: string,
    query: string,
    options?: FileSearchOptions,
    cursor?: string,
  ): Promise<FileSearchPage>;
}

export interface FileContentReader {
  getFile(path: string): Promise<FileContent | null>;
}

export type FileCollection = FileTreeReader & FileContentReader;
