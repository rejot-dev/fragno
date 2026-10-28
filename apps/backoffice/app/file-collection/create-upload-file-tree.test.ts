import { describe, expect, test } from "vitest";

import { createUploadFileTree } from "./create-upload-file-tree";

describe("createUploadFileTree", () => {
  test("projects ready records into a serializable file tree", () => {
    const tree = createUploadFileTree([
      {
        fileKey: "docs/.fragno/dir-marker",
        filename: "dir-marker",
        sizeBytes: 0,
        contentType: "application/x.fragno-directory-marker",
        metadata: { __docsDirectoryMarker: true },
        updatedAt: new Date("2026-08-01T10:00:00.000Z"),
        status: "ready",
      },
      {
        fileKey: "docs/README.md",
        filename: "Workspace README",
        sizeBytes: 7,
        contentType: "text/markdown",
        checksum: { algo: "sha256", value: "abc" },
        metadata: { source: "test" },
        updatedAt: new Date("2026-08-01T11:00:00.000Z"),
        status: "ready",
      },
      {
        fileKey: "ignored-pending.txt",
        filename: "ignored-pending.txt",
        sizeBytes: 1,
        contentType: "text/plain",
        status: "pending",
      },
      {
        fileKey: "ignored-deleted.txt",
        filename: "ignored-deleted.txt",
        sizeBytes: 1,
        contentType: "text/plain",
        status: "ready",
        deletedAt: "2026-08-01T12:00:00.000Z",
      },
    ]);

    expect(tree.entries).toEqual([
      {
        kind: "directory",
        path: "docs",
        updatedAt: "2026-08-01T10:00:00.000Z",
        metadata: { __docsDirectoryMarker: true },
      },
      {
        kind: "file",
        path: "docs/README.md",
        displayName: "Workspace README",
        sizeBytes: 7,
        contentType: "text/markdown",
        updatedAt: "2026-08-01T11:00:00.000Z",
        metadata: { source: "test" },
        contentVersion: "sha256:abc",
      },
    ]);
  });

  test("normalizes a non-empty collection prefix", () => {
    const tree = createUploadFileTree(
      [
        {
          fileKey: "workspace/docs/README.md",
          filename: "README.md",
          sizeBytes: 7,
          contentType: "text/markdown",
          status: "ready",
        },
      ],
      { prefix: "workspace" },
    );

    expect(tree.entries.map(({ path }) => path)).toEqual(["docs", "docs/README.md"]);
  });
});
