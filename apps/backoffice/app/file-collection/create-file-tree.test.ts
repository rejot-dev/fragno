import { describe, expect, test } from "vitest";

import { createFileTree } from "./create-file-tree";

describe("createFileTree", () => {
  test.each(["/README.md", "docs/", "docs//README.md"])(
    "rejects empty path segments in %s",
    (path) => {
      expect(() =>
        createFileTree([
          {
            kind: "file",
            path,
            sizeBytes: 1,
            contentType: "text/plain",
            updatedAt: null,
            metadata: null,
          },
        ]),
      ).toThrow("contains an empty path segment");
    },
  );
});
