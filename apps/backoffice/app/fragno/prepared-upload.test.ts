import { describe, expect, test, assert } from "vitest";

import {
  preparedUploadedFileReferenceSchema,
  uploadedFileReferenceSchema,
} from "./prepared-upload";

const preparedFile = {
  kind: "prepared-upload" as const,
  scope: { kind: "org" as const, orgId: "org-1" },
  uploadId: "upload-1",
  provider: "database",
  fileKey: "generated-ui/file.txt",
  filename: "file.txt",
  sizeBytes: 5,
  contentType: "text/plain",
  expiresAt: "2027-01-01T00:00:00.000Z",
};

describe("prepared upload references", () => {
  test("accepts persisted references only with concrete routable scopes", () => {
    expect(preparedUploadedFileReferenceSchema.parse(preparedFile)).toEqual(preparedFile);
    assert(
      !preparedUploadedFileReferenceSchema.safeParse({
        ...preparedFile,
        scope: { kind: "current" },
      }).success,
    );
  });

  test("validates committed references without prepared-upload expiration metadata", () => {
    const { expiresAt: _, ...uploadedFile } = preparedFile;

    expect(uploadedFileReferenceSchema.parse({ ...uploadedFile, kind: "uploaded-file" })).toEqual({
      ...uploadedFile,
      kind: "uploaded-file",
    });
  });
});
