import type {
  SandboxContainerControl,
  SandboxExecOutcome,
} from "@fragno-apps/cf-sandbox-bridge/sandbox/sandbox-container-contract";

import type {
  ExecuteSandboxCommandOptions,
  SandboxCommandFailure,
  SandboxCommandResult,
} from "./contracts";
import { SandboxRuntimeError } from "./sandbox-runtime-error";

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/** Runs a shell command in a sandbox and maps its outcome into the stable Backoffice result. */
export async function executeSandboxCommand(
  sandbox: Pick<SandboxContainerControl, "exec">,
  command: string,
  options: ExecuteSandboxCommandOptions = {},
): Promise<SandboxCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  try {
    return toSandboxCommandResult(
      await sandbox.exec({ argv: ["sh", "-lc", command], timeoutMs }),
      timeoutMs,
    );
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

function toSandboxCommandResult(
  outcome: SandboxExecOutcome,
  timeoutMs: number,
): SandboxCommandResult {
  if (outcome.status === "exited") {
    return outcome.exitCode === 0
      ? { ok: true, stdout: outcome.stdout, stderr: outcome.stderr, exitCode: 0 }
      : classifyCommandExit(outcome);
  }
  if (outcome.status === "timed_out") {
    return {
      ok: false,
      code: "timeout",
      reason: "timeout",
      message: `Command timed out after ${timeoutMs}ms.`,
      stdout: outcome.stdout || undefined,
      stderr: outcome.stderr || undefined,
      retryable: true,
    };
  }
  if (outcome.status === "output_limit_exceeded") {
    return {
      ok: false,
      code: "output_limit_exceeded",
      reason: "output_limit_exceeded",
      message: `Command output exceeded ${outcome.limitBytes} bytes.`,
      retryable: false,
    };
  }
  return {
    ok: false,
    code: "sandbox_terminated",
    reason: "sandbox_terminated",
    message: "The sandbox container is not running. Start the sandbox again to resume it.",
    retryable: false,
  };
}

function classifyCommandExit(
  outcome: Extract<SandboxExecOutcome, { status: "exited" }>,
): SandboxCommandFailure {
  const stderr = outcome.stderr.trim() || undefined;
  const stdout = outcome.stdout.trim() || undefined;
  const message = stderr ?? stdout ?? `Command failed with exit code ${outcome.exitCode}.`;
  return {
    ok: false,
    code: "command_failed",
    reason: "command_failed",
    message,
    stdout,
    stderr,
    exitCode: outcome.exitCode,
    retryable: false,
  };
}

// Typed outcomes cover every command result, so a thrown error means the Durable Object or its
// container failed underneath the command. RPC preserves only the message.
function classifySandboxRuntimeThrownError(error: unknown): SandboxCommandFailure {
  return {
    ok: false,
    code: "sandbox_unavailable",
    reason: "sandbox_unavailable",
    message: toSandboxRuntimeErrorMessage(error),
    retryable: true,
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
