import { describe, expect, it } from "vitest";

import {
  buildUploadFileKey,
  buildUploadKeyPrefix,
  validateUploadKeySegment,
} from "./upload-panel-state";

describe("upload panel key helpers", () => {
  it("builds prefixes from valid segments without mutating them", () => {
    expect(
      buildUploadKeyPrefix([
        { label: "Collection", value: "customer-assets" },
        { label: "Entity ID", value: "42" },
      ]),
    ).toEqual({
      keyPrefix: "customer-assets/42/",
      error: null,
    });
  });

  it("rejects slashes and surrounding whitespace instead of normalizing segments", () => {
    expect(validateUploadKeySegment("Collection", "a/b")).toBe("Collection cannot include '/'.");
    expect(validateUploadKeySegment("Entity ID", " 42 ")).toBe(
      "Entity ID cannot start or end with whitespace.",
    );
  });

  it("rejects ambiguous file names when building a file key", () => {
    expect(buildUploadFileKey("customer-assets/42/", "a/b.csv")).toEqual({
      fileKey: null,
      error: "File name cannot include '/'.",
    });
    expect(buildUploadFileKey("customer-assets/42/", "a-b.csv")).toEqual({
      fileKey: "customer-assets/42/a-b.csv",
      error: null,
    });
  });
});
