import type { SandboxOptions as CloudflareSdkSandboxOptions } from "@cloudflare/sandbox";

import type {
  ExecuteSandboxCommandOptions,
  FileExistsResult,
  MkdirOptions,
  MountBucketOptions,
  SandboxCommandFailure,
  SandboxInstanceStatus,
  SandboxRuntimeExecOptions,
  SandboxRuntimeExecResult,
  SandboxRuntimeHandle,
  SandboxRuntimeHandleOptions,
  SandboxRuntimeProvider,
  WriteFileOptions,
} from "./contracts";
import { CLOUDFLARE_SANDBOX_PROVIDER } from "./contracts";

type CloudflareSandboxNamespace = CloudflareEnv["SANDBOX"];
type CloudflareSandboxOptions = Pick<CloudflareSdkSandboxOptions, "keepAlive" | "sleepAfter">;

type CloudflareSandboxRawHandle = {
  exec(command: string, options?: SandboxRuntimeExecOptions): Promise<SandboxRuntimeExecResult>;
  destroy(): Promise<void>;
  mountBucket(bucket: string, mountPoint: string, options: MountBucketOptions): Promise<void>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  writeFile(path: string, content: string, options?: WriteFileOptions): Promise<void>;
  exists(path: string): Promise<FileExistsResult>;
  getRuntimeStatus(): Promise<{ status: SandboxInstanceStatus }>;
};

type CloudflareSandboxSdkClient = {
  getSandbox(
    namespace: CloudflareSandboxNamespace,
    id: string,
    options?: CloudflareSandboxOptions,
  ): CloudflareSandboxRawHandle | Promise<CloudflareSandboxRawHandle>;
};

export type CloudflareSandboxProviderOptions = {
  sandboxNamespace: CloudflareSandboxNamespace;
  sdk: CloudflareSandboxSdkClient;
};

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
];

export const createCloudflareSandboxProvider = ({
  sandboxNamespace,
  sdk,
}: CloudflareSandboxProviderOptions): SandboxRuntimeProvider => ({
  provider: CLOUDFLARE_SANDBOX_PROVIDER,
  async getHandle(id: string, options?: SandboxRuntimeHandleOptions) {
    const rawHandle = await sdk.getSandbox(sandboxNamespace, id, stripUndefined(options ?? {}));
    return adaptCloudflareSandboxHandle(id, rawHandle);
  },
  async getStatus(id, existingHandle) {
    try {
      const sandbox = existingHandle ?? (await this.getHandle(id));
      return (await sandbox.getRuntimeStatus()).status;
    } catch (error) {
      console.warn("Failed to get live Cloudflare sandbox runtime status", {
        sandboxId: id,
        error,
      });
      return "error";
    }
  },
});

const adaptCloudflareSandboxHandle = (
  id: string,
  rawHandle: CloudflareSandboxRawHandle,
): SandboxRuntimeHandle => ({
  id,
  exec: async (command, options) => await rawHandle.exec(command, options),
  destroy: async () => await rawHandle.destroy(),
  getRuntimeStatus: async () => await rawHandle.getRuntimeStatus(),
  mountBucket: async (bucket, mountPoint, options) =>
    await rawHandle.mountBucket(bucket, mountPoint, options),
  mkdir: async (path, options) => await rawHandle.mkdir(path, options),
  writeFile: async (path, content, options) => await rawHandle.writeFile(path, content, options),
  exists: async (path) => await rawHandle.exists(path),
  async executeCommand(command: string, options?: ExecuteSandboxCommandOptions) {
    try {
      const result = await rawHandle.exec(command, toRuntimeExecOptions(options));
      if (result.success) {
        return {
          ok: true as const,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode ?? 0,
        };
      }

      return classifyResultFailure(result);
    } catch (error) {
      return classifyThrownError(error);
    }
  },
});

function classifyResultFailure(result: SandboxRuntimeExecResult): SandboxCommandFailure {
  const stderr = result.stderr?.trim() || undefined;
  const stdout = result.stdout?.trim() || undefined;
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
    reason: "command_failed",
    message,
    stdout,
    stderr,
    exitCode: result.exitCode ?? undefined,
    retryable: false,
  };
}

function classifyThrownError(error: unknown): SandboxCommandFailure {
  const message = toErrorMessage(error);
  const normalized = message.toLowerCase();

  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return {
      ok: false,
      reason: "timeout",
      message,
      retryable: true,
    };
  }

  if (TERMINATED_MESSAGE_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return {
      ok: false,
      reason: "sandbox_terminated",
      message,
      retryable: true,
    };
  }

  if (UNAVAILABLE_MESSAGE_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return {
      ok: false,
      reason: "sandbox_unavailable",
      message,
      retryable: true,
    };
  }

  return {
    ok: false,
    reason: "internal_error",
    message,
    retryable: false,
  };
}

function toRuntimeExecOptions(options?: ExecuteSandboxCommandOptions): SandboxRuntimeExecOptions {
  return stripUndefined({ timeout: options?.timeoutMs });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    const serialized = JSON.stringify(error);
    return serialized ?? "Unknown sandbox execution error.";
  } catch {
    return "Unknown sandbox execution error.";
  }
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, propertyValue]) => propertyValue !== undefined),
  ) as Partial<T>;
}
