import { describe, expect, it } from "vitest";

import {
  appendStorageObjectKeyVersionSegment,
  buildStorageObjectVersionSegment,
} from "./object-key";

describe("storage object key versioning", () => {
  it("appends the version as a trailing path segment", () => {
    expect(
      appendStorageObjectKeyVersionSegment(
        "uploads/filesystem/users/1/avatar",
        "20260319T115043123Z",
      ),
    ).toBe("uploads/filesystem/users/1/avatar/20260319T115043123Z");
  });

  it("builds lexicographically sortable UTC basic timestamps", () => {
    expect(buildStorageObjectVersionSegment(Date.UTC(2026, 2, 19, 11, 50, 43, 123))).toBe(
      "20260319T115043123Z",
    );
    expect(buildStorageObjectVersionSegment(Date.UTC(2026, 2, 19, 11, 50, 43, 124))).toBe(
      "20260319T115043124Z",
    );
  });

  it("returns the same timestamp segment for the same millisecond", () => {
    const now = Date.UTC(2026, 2, 19, 11, 50, 43, 200);
    expect(buildStorageObjectVersionSegment(now)).toBe("20260319T115043200Z");
    expect(buildStorageObjectVersionSegment(now)).toBe("20260319T115043200Z");
    expect(buildStorageObjectVersionSegment(now)).toBe("20260319T115043200Z");
  });

  it("rejects invalid version segments", () => {
    expect(() =>
      appendStorageObjectKeyVersionSegment("uploads/filesystem/users/1/avatar", "bad/value"),
    ).toThrow("Invalid storage object key version segment");
  });
});
