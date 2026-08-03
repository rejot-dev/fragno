import { createFileTree } from "./create-file-tree";
import type { FileTree, FileTreeEntry } from "./file-collection";

export type UploadFileTreeRecord = {
  provider?: string;
  fileKey: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
  checksum?: { algo: "sha256" | "md5"; value: string } | null;
  metadata?: Record<string, unknown> | null;
  updatedAt?: string | Date | null;
  status?: string;
  deletedAt?: string | Date | null;
};

export type UploadFileTreeOptions = {
  provider: string;
  prefix?: string;
};

export function createUploadFileTree(
  records: readonly UploadFileTreeRecord[],
  options: UploadFileTreeOptions,
): FileTree {
  return createFileTree(createUploadFileTreeEntries(records, options));
}

export function createUploadFileTreeEntries(
  records: readonly UploadFileTreeRecord[],
  options: UploadFileTreeOptions,
): FileTreeEntry[] {
  const prefix = normalizeFileCollectionPrefix(options.prefix);
  const entries: FileTreeEntry[] = [];

  for (const record of records) {
    if (
      (record.provider !== undefined && record.provider !== options.provider) ||
      (record.status !== undefined && record.status !== "ready") ||
      record.deletedAt
    ) {
      continue;
    }
    if (!record.fileKey.startsWith(prefix)) {
      continue;
    }

    const path = record.fileKey.slice(prefix.length);

    if (isUploadDirectoryMarker(record)) {
      entries.push({
        kind: "directory",
        path: path.slice(0, -"/.fragno/dir-marker".length),
        updatedAt: serializeDate(record.updatedAt),
        metadata: record.metadata ?? null,
      });
      continue;
    }

    entries.push({
      kind: "file",
      path,
      displayName: record.filename,
      sizeBytes: record.sizeBytes,
      contentType: record.contentType,
      updatedAt: serializeDate(record.updatedAt),
      metadata: record.metadata ?? null,
      ...(record.checksum
        ? { contentVersion: `${record.checksum.algo}:${record.checksum.value}` }
        : {}),
    });
  }

  return entries;
}

export function normalizeFileCollectionPrefix(prefix: string | undefined): string {
  if (!prefix || prefix.endsWith("/")) {
    return prefix ?? "";
  }
  return `${prefix}/`;
}

function serializeDate(value: string | Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : (value ?? null);
}

function isUploadDirectoryMarker(record: UploadFileTreeRecord): boolean {
  if (!record.fileKey.endsWith("/.fragno/dir-marker")) {
    return false;
  }

  return (
    record.contentType === "application/x.fragno-directory-marker" ||
    record.metadata?.__docsDirectoryMarker === true
  );
}
