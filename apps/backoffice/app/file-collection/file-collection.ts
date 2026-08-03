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

export interface FileTreeReader {
  getTree(): Promise<FileTree>;
}

export interface FileContentReader {
  getFile(path: string): Promise<FileContent | null>;
}

export type FileCollection = FileTreeReader & FileContentReader;
