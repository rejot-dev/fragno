import { AirweaveSDKError } from "@airweave/sdk";
import { FragnoApiError, type StatusCode } from "@fragno-dev/core/api";

export function toFragmentError(error: unknown): FragnoApiError {
  if (error instanceof AirweaveSDKError) {
    let message = error.message;
    // Get detailed message in body of Airweave errors
    if ("body" in error && error.body && typeof error.body === "object" && "detail" in error.body) {
      message = (error.body as { detail: string }).detail;
    }
    return new FragnoApiError(
      { message, code: "AIRWEAVE_SDK_ERROR" },
      error.statusCode as StatusCode,
    );
  }

  return new FragnoApiError(
    {
      message: "Internal server error",
      code: "INTERNAL_ERROR",
    },
    500,
  );
}
