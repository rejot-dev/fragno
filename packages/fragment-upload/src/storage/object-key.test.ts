import { describe, expect, it, assert } from "vitest";

import {
  appendStorageObjectKeyVersionSegment,
  buildStorageObjectVersionSegment,
} from "./object-key";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("storage object key versioning", () => {
  it("appends the version as a trailing path segment", () => {
    const versionSegment = "f5ad4f84-d68f-438b-97b2-cf61d36f012f";
    assert(
      appendStorageObjectKeyVersionSegment("uploads/filesystem/users/1/avatar", versionSegment) ===
        `uploads/filesystem/users/1/avatar/${versionSegment}`,
    );
  });

  it("builds a unique UUID for each physical object", () => {
    const first = buildStorageObjectVersionSegment();
    const second = buildStorageObjectVersionSegment();

    expect(first).toMatch(UUID_PATTERN);
    expect(second).toMatch(UUID_PATTERN);
    expect(second).not.toBe(first);
  });

  it("rejects invalid version segments", () => {
    expect(() =>
      appendStorageObjectKeyVersionSegment("uploads/filesystem/users/1/avatar", "bad/value"),
    ).toThrow("Invalid storage object key version segment");
  });
});
