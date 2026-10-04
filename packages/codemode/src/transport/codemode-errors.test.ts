import { describe, expect, test } from "vitest";

import { decodeCodemodeError, encodeCodemodeError } from "./codemode-errors";

class StructuredRequestError extends Error {
  readonly status = 404;
  readonly code = "SESSION_NOT_FOUND";

  constructor() {
    super("Pi session was not found.");
    this.name = "PiManagerRuntimeRequestError";
  }
}

describe("codemode error transport", () => {
  test("preserves safe request status and code fields", () => {
    const decoded = decodeCodemodeError(
      encodeCodemodeError(new StructuredRequestError()),
    ) as Error & {
      status: number;
      code: string;
    };

    expect(decoded).toMatchObject({
      name: "PiManagerRuntimeRequestError",
      message: "Pi session was not found.",
      status: 404,
      code: "SESSION_NOT_FOUND",
    });
  });

  test("does not invent structured details for ordinary errors", () => {
    expect(encodeCodemodeError(new Error("boom")).details).toBeNull();
  });
});
