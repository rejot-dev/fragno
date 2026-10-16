import { describe, it, assert } from "vitest";

import { shouldAutoStartUploads } from "./upload-queue";

describe("upload files helpers", () => {
  it("auto-starts queued uploads for the root prefix", () => {
    assert(
      shouldAutoStartUploads({
        uploadingFiles: false,
        defaultProvider: "r2-binding",
        nextQueuedUploadPrefix: "",
      }),
    );
  });

  it("does not auto-start when there is no queued prefix", () => {
    assert(
      !shouldAutoStartUploads({
        uploadingFiles: false,
        defaultProvider: "r2-binding",
        nextQueuedUploadPrefix: null,
      }),
    );
  });
});
