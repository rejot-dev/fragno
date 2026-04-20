import { describe, expect, it } from "vitest";

import { deriveInternalUrls } from "./utils";

describe("deriveInternalUrls", () => {
  it("preserves query parameters when deriving submit and internal URLs", () => {
    expect(
      deriveInternalUrls("https://example.com/app/_internal/outbox?token=abc&mode=cli"),
    ).toEqual({
      submitUrl: "https://example.com/app/_internal/sync?token=abc&mode=cli",
      internalUrl: "https://example.com/app/_internal?token=abc&mode=cli",
    });
  });
});
