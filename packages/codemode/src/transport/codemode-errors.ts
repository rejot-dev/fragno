import { RemoteWorkflowSuspendedError } from "@fragno-dev/workflows/remote-workflow";
import { NonRetryableError, WaitForEventTimeoutError } from "@fragno-dev/workflows/workflow";

import type { CodemodeWireError } from "./codemode-protocol";

/** Interruption is an unknown outcome, not permission to retry an immediate invocation. */
export class CodemodeInterruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodemodeInterruptedError";
  }
}

/** Preserves workflow failure classes across the network; stacks and causes stay local. */
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
  };
}

/** Restores classes used by the authoritative workflow runner to classify failures. */
export function decodeCodemodeError(error: CodemodeWireError): Error {
  switch (error.kind) {
    case "non-retryable":
      return new NonRetryableError(error.message);
    case "event-timeout":
      return new WaitForEventTimeoutError();
    case "interrupted":
      return new CodemodeInterruptedError(error.message);
    case "error":
      break;
  }
  const result = new Error(error.message);
  result.name = error.name;
  return result;
}

/** RPC cannot carry custom Error properties, so workflow proxies return typed suspension values. */
export async function codemodeHostCall(call: () => Promise<unknown>): Promise<unknown> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof RemoteWorkflowSuspendedError) {
      return { __fragnoRemoteWorkflowSuspended: true, reason: error.reason };
    }
    throw error;
  }
}
