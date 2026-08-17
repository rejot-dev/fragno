import { describe, expect, test } from "vitest";

import { NonRetryableError } from "@fragno-dev/workflows/workflow";

import {
  throwMarketplaceUploadRequestError,
  throwMarketplaceUploadRouteError,
  throwUnexpectedMarketplaceUploadResponse,
} from "./marketplace-upload-errors";

const captureError = (
  operation: () => never,
): Error & {
  operation?: string;
  status?: number;
  code?: string | null;
} => {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error & {
      operation?: string;
      status?: number;
      code?: string | null;
    };
  }
  throw new Error("Expected operation to throw.");
};

describe("Marketplace Upload error classification", () => {
  test.each(["STORAGE_ERROR", "UPLOAD_EXPIRED"])("keeps typed %s failures retryable", (code) => {
    const error = captureError(() =>
      throwMarketplaceUploadRouteError({
        operation: "Marketplace upload",
        status: 400,
        error: { code, message: "Retry this operation." },
      }),
    );

    expect(error).not.toBeInstanceOf(NonRetryableError);
    expect(error).toMatchObject({
      operation: "Marketplace upload",
      status: 400,
      code,
    });
  });

  test.each([408, 429, 500, 503])("keeps unexpected HTTP %s responses retryable", (status) => {
    const error = captureError(() =>
      throwUnexpectedMarketplaceUploadResponse({
        operation: "Marketplace upload",
        status,
      }),
    );

    expect(error).not.toBeInstanceOf(NonRetryableError);
    expect(error).toMatchObject({
      operation: "Marketplace upload",
      status,
      code: null,
    });
  });

  test("includes validation issue paths in permanent Upload failures", () => {
    const error = captureError(() =>
      throwMarketplaceUploadRouteError({
        operation: "Marketplace artifact batch commit",
        status: 400,
        error: {
          code: "FRAGNO_VALIDATION_ERROR",
          message: "Validation failed",
          issues: [{ path: ["entries", 0, "uploadId"], message: "Expected string" }],
        },
      }),
    );

    expect(error.message).toContain("entries.0.uploadId: Expected string");
  });

  test("marks permanent typed Upload failures non-retryable", () => {
    const error = captureError(() =>
      throwMarketplaceUploadRouteError({
        operation: "Marketplace upload",
        status: 400,
        error: {
          code: "INVALID_CHECKSUM",
          message: "The checksum does not match.",
        },
      }),
    );

    expect(error).toBeInstanceOf(NonRetryableError);
    expect(error).toMatchObject({
      operation: "Marketplace upload",
      status: 400,
      code: "INVALID_CHECKSUM",
    });
  });

  test("marks unexpected permanent HTTP responses non-retryable", () => {
    const error = captureError(() =>
      throwMarketplaceUploadRequestError({
        operation: "Marketplace upload",
        status: 409,
        code: null,
        message: "Upload returned an unexpected response.",
      }),
    );

    expect(error).toBeInstanceOf(NonRetryableError);
    expect(error).toMatchObject({
      operation: "Marketplace upload",
      status: 409,
      code: null,
    });
  });
});
