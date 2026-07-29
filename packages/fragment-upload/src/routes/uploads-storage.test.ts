import { assert, describe, it } from "vitest";

import { UploadServiceError } from "../services/errors";
import { UploadStorageError } from "../storage/errors";
import { mapStorageOperationError } from "./uploads-storage";

describe("mapStorageOperationError", () => {
  it("preserves errors that were already mapped at the storage boundary", () => {
    const cause = new UploadServiceError("INVALID_CHECKSUM", "The checksum is invalid.");

    assert(mapStorageOperationError(cause) === cause);
  });

  it("preserves typed checksum failures", () => {
    const error = mapStorageOperationError(
      new UploadStorageError("INVALID_CHECKSUM", "Checksum wording may change."),
    );

    assert(error.code === "INVALID_CHECKSUM");
  });

  it("does not classify unrelated errors by message", () => {
    const error = mapStorageOperationError(new Error("INVALID_CHECKSUM"));

    assert(error.code === "STORAGE_ERROR");
  });
});
