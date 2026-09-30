import type { SandboxCommandFailureReason } from "./contracts";

/** Typed sandbox runtime failure used to preserve provider codes and retry policy. */
export class SandboxRuntimeError extends Error {
  readonly code: string;
  readonly reason: SandboxCommandFailureReason;
  readonly retryable: boolean;

  constructor(input: {
    code: string;
    reason: SandboxCommandFailureReason;
    retryable: boolean;
    message: string;
  }) {
    super(input.message);
    this.name = "SandboxRuntimeError";
    this.code = input.code;
    this.reason = input.reason;
    this.retryable = input.retryable;
  }
}
