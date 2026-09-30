import type {
  ExecuteSandboxCommandOptions,
  SandboxCommandFailure,
  SandboxCommandResult,
  SandboxRuntimeExecOptions,
  SandboxRuntimeExecResult,
} from "./contracts";
import { SandboxRuntimeError } from "./sandbox-runtime-error";

type ExecuteSandboxRuntimeCommand = (
  command: string,
  options?: SandboxRuntimeExecOptions,
) => Promise<SandboxRuntimeExecResult>;

/** Executes a sandbox command and maps runtime failures into the stable Backoffice result contract. */
export async function executeSandboxRuntimeCommand(
  execute: ExecuteSandboxRuntimeCommand,
  command: string,
  options?: ExecuteSandboxCommandOptions,
): Promise<SandboxCommandResult> {
  try {
    const result = await execute(
      command,
      options?.timeoutMs === undefined ? {} : { timeout: options.timeoutMs },
    );
    if (result.success) {
      return {
        ok: true,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? 0,
      };
    }

    return classifySandboxRuntimeResultFailure(result);
  } catch (error) {
    if (error instanceof SandboxRuntimeError) {
      return {
        ok: false,
        code: error.code,
        reason: error.reason,
        message: error.message,
        retryable: error.retryable,
      };
    }
    return classifySandboxRuntimeThrownError(error);
  }
}

function classifySandboxRuntimeResultFailure(
  result: SandboxRuntimeExecResult,
): SandboxCommandFailure {
  const stderr = result.stderr.trim() || undefined;
  const stdout = result.stdout.trim() || undefined;
  const message =
    stderr ??
    stdout ??
    (result.exitCode === null
      ? "Command did not return an exit code."
      : `Command failed with exit code ${result.exitCode}.`);

  const normalized = message.toLowerCase();
  const sandboxLikelyTerminated =
    result.exitCode === 137 ||
    result.exitCode === 143 ||
    normalized.includes("killed") ||
    normalized.includes("terminated");

  if (sandboxLikelyTerminated) {
    return {
      ok: false,
      code: "sandbox_terminated",
      reason: "sandbox_terminated",
      message,
      stdout,
      stderr,
      exitCode: result.exitCode ?? undefined,
      retryable: true,
    };
  }

  return {
    ok: false,
    code: "command_failed",
    reason: "command_failed",
    message,
    stdout,
    stderr,
    exitCode: result.exitCode ?? undefined,
    retryable: false,
  };
}

function classifySandboxRuntimeThrownError(error: unknown): SandboxCommandFailure {
  const message = toSandboxRuntimeErrorMessage(error);
  const normalized = message.toLowerCase();

  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return {
      ok: false,
      code: "timeout",
      reason: "timeout",
      message,
      retryable: true,
    };
  }

  if (TERMINATED_MESSAGE_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return {
      ok: false,
      code: "sandbox_terminated",
      reason: "sandbox_terminated",
      message,
      retryable: true,
    };
  }

  if (UNAVAILABLE_MESSAGE_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return {
      ok: false,
      code: "sandbox_unavailable",
      reason: "sandbox_unavailable",
      message,
      retryable: true,
    };
  }

  return {
    ok: false,
    code: "internal_error",
    reason: "internal_error",
    message,
    retryable: false,
  };
}

function toSandboxRuntimeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error) ?? "Unknown sandbox execution error.";
  } catch {
    return "Unknown sandbox execution error.";
  }
}

const TERMINATED_MESSAGE_PATTERNS = [
  "sandbox has been destroyed",
  "sandbox destroyed",
  "container exited",
  "instance not found",
  "no such container",
  "broken pipe",
  "connection reset",
];

const UNAVAILABLE_MESSAGE_PATTERNS = [
  "temporarily unavailable",
  "unable to connect",
  "network error",
  "fetch failed",
  "bridge unavailable",
];
