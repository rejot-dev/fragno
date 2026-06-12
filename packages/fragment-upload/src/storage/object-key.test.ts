import { describe, expect, it, assert } from "vitest";

import {
  appendStorageObjectKeyVersionSegment,
  buildStorageObjectVersionSegment,
} from "./object-key";

describe("storage object key versioning", () => {
  it("appends the version as a trailing path segment", () => {
    assert(
      appendStorageObjectKeyVersionSegment(
        "uploads/filesystem/users/1/avatar",
        "20260319T115043123Z",
      ) === "uploads/filesystem/users/1/avatar/20260319T115043123Z",
    );
  });

  it("builds lexicographically sortable UTC basic timestamps", () => {
    assert(
      buildStorageObjectVersionSegment(Date.UTC(2026, 2, 19, 11, 50, 43, 123)) ===
        "20260319T115043123Z",
    );
    assert(
      buildStorageObjectVersionSegment(Date.UTC(2026, 2, 19, 11, 50, 43, 124)) ===
        "20260319T115043124Z",
    );
  });

  it("returns the same timestamp segment for the same millisecond", () => {
    const now = Date.UTC(2026, 2, 19, 11, 50, 43, 200);
    assert(buildStorageObjectVersionSegment(now) === "20260319T115043200Z");
    assert(buildStorageObjectVersionSegment(now) === "20260319T115043200Z");
    assert(buildStorageObjectVersionSegment(now) === "20260319T115043200Z");
  });

  it("rejects invalid version segments", () => {
    expect(() =>
      appendStorageObjectKeyVersionSegment("uploads/filesystem/users/1/avatar", "bad/value"),
    ).toThrow("Invalid storage object key version segment");
  });
});
