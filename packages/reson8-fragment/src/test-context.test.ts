import { describe, test, assert } from "vitest";

import { createJsonResponse } from "./test-context";

describe("createJsonResponse", () => {
  test("preserves Headers instances and explicit content types", () => {
    const response = createJsonResponse(
      { error: "invalid" },
      {
        headers: new Headers({
          "content-type": "application/problem+json",
          "x-request-id": "request-1",
        }),
      },
    );

    assert(response.headers.get("content-type") === "application/problem+json");
    assert(response.headers.get("x-request-id") === "request-1");
  });
});
