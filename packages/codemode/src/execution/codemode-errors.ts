import { NonRetryableError, WaitForEventTimeoutError } from "@fragno-dev/workflows/workflow";

import type { CodemodeWireError } from "./codemode-activation-contract";

/** Interruption is an unknown outcome, not permission to retry an immediate invocation. */
export class CodemodeInterruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodemodeInterruptedError";
  }
}

function codemodeErrorDetails(error: unknown): CodemodeWireError["details"] {
  if (error === null || typeof error !== "object") {
    return null;
  }
  const status = "status" in error ? error.status : null;
  const code = "code" in error ? error.code : null;
  return typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599 &&
    typeof code === "string"
    ? { status, code: code.slice(0, 1024) }
    : null;
}

function restoreCodemodeErrorDetails(error: Error, details: CodemodeWireError["details"]): Error {
  if (details) {
    Object.defineProperties(error, {
      status: { value: details.status, enumerable: true },
      code: { value: details.code, enumerable: true },
    });
  }
  return error;
}

/** Preserves workflow failure classes and safe structured details; stacks and causes stay local. */
export function encodeCodemodeError(error: unknown): CodemodeWireError {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind:
      name === "NonRetryableError"
        ? "non-retryable"
        : name === "WaitForEventTimeoutError"
          ? "event-timeout"
          : name === "CodemodeInterruptedError"
            ? "interrupted"
            : "error",
    name: name.slice(0, 1024),
    message: message.slice(0, 32_768),
    details: codemodeErrorDetails(error),
  };
}

/** Restores classes used by the authoritative workflow runner to classify failures. */
export function decodeCodemodeError(error: CodemodeWireError): Error {
  let result: Error;
  switch (error.kind) {
    case "non-retryable":
      result = new NonRetryableError(error.message);
      break;
    case "event-timeout":
      result = new WaitForEventTimeoutError();
      break;
    case "interrupted":
      result = new CodemodeInterruptedError(error.message);
      break;
    case "error":
      result = new Error(error.message);
      result.name = error.name;
      break;
  }
  return restoreCodemodeErrorDetails(result, error.details);
}
