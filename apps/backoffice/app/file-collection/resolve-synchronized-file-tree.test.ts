import { describe, expect, test } from "vitest";

import { createFileTree } from "./create-file-tree";
import { resolveSynchronizedFileTree } from "./resolve-synchronized-file-tree";

const initialTree = createFileTree([
  {
    kind: "file",
    path: "server.txt",
    sizeBytes: 6,
    contentType: "text/plain",
    updatedAt: null,
    metadata: null,
  },
]);

describe("resolveSynchronizedFileTree", () => {
  test("uses the server snapshot while local synchronization is loading", () => {
    expect(resolveSynchronizedFileTree(initialTree, { status: "loading" })).toBe(initialTree);
  });

  test("atomically replaces the server snapshot when local synchronization is ready", () => {
    const localTree = createFileTree([
      {
        kind: "file",
        path: "optimistic.txt",
        sizeBytes: 10,
        contentType: "text/plain",
        updatedAt: null,
        metadata: null,
      },
    ]);

    expect(resolveSynchronizedFileTree(initialTree, { status: "ready", tree: localTree })).toBe(
      localTree,
    );
    expect(
      resolveSynchronizedFileTree(initialTree, { status: "ready", tree: localTree }).entries.map(
        (entry) => entry.path,
      ),
    ).toEqual(["optimistic.txt"]);
  });

  test("retains the server snapshot when local synchronization fails", () => {
    expect(
      resolveSynchronizedFileTree(initialTree, {
        status: "error",
        error: new Error("Sync failed"),
      }),
    ).toBe(initialTree);
  });
});
