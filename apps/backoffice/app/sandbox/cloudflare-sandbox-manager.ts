import type {
  Sandbox as CloudflareSdkSandbox,
  SandboxOptions as CloudflareSdkSandboxOptions,
} from "@cloudflare/sandbox";

import type {
  ExecuteSandboxCommandOptions,
  MkdirOptions,
  MountBucketOptions,
  WriteFileOptions,
  FileExistsResult,
  SandboxCommandFailure,
  SandboxCommandResult,
  SandboxHandle,
  SandboxInstanceSummary,
  SandboxManager,
  StartSandboxOptions,
} from "./contracts";
import { parseSleepAfterInput } from "./sleep-after";

type CloudflareSandboxNamespace = CloudflareEnv["SANDBOX"];
type CloudflareSandboxOptions = Pick<CloudflareSdkSandboxOptions, "keepAlive" | "sleepAfter">;
type CloudflareExecOptions = {
  timeout?: number;
};
type CloudflareExecResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

type CloudflareSandboxHandle = Pick<
  CloudflareSdkSandbox,
  "exec" | "destroy" | "mountBucket" | "mkdir" | "writeFile" | "exists"
>;

type SandboxRegistryClient = {
  getInstances(): Promise<SandboxInstanceSummary[]>;
  getInstance(id: string): Promise<SandboxInstanceSummary | null>;
  trackInstance(id: string): Promise<void>;
  untrackInstance(id: string): Promise<void>;
};

type SandboxSdkClient = {
  getSandbox(
    namespace: CloudflareSandboxNamespace,
    id: string,
    options?: CloudflareSandboxOptions,
  ): CloudflareSandboxHandle;
};

export type CloudflareSandboxManagerOptions = {
  sandboxNamespace: CloudflareSandboxNamespace;
  sandboxIdScope?: string;
  registry: SandboxRegistryClient;
  sdk: SandboxSdkClient;
};

const SANDBOX_SCOPE_SEPARATOR = "::";

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

export function createCloudflareSandboxManager(
  options: CloudflareSandboxManagerOptions,
): SandboxManager {
  return new CloudflareSandboxManager({
    sandboxNamespace: options.sandboxNamespace,
    sandboxIdScope: options.sandboxIdScope,
    registry: options.registry,
    sdk: options.sdk,
  });
}

class CloudflareSandboxManager implements SandboxManager {
  #sandboxNamespace: CloudflareSandboxNamespace;
  #sandboxIdScope: string | null;
  #registry: SandboxRegistryClient;
  #sdk: SandboxSdkClient;

  constructor(options: {
    sandboxNamespace: CloudflareSandboxNamespace;
    sandboxIdScope?: string;
    registry: SandboxRegistryClient;
    sdk: SandboxSdkClient;
  }) {
    this.#sandboxNamespace = options.sandboxNamespace;
    this.#sandboxIdScope = options.sandboxIdScope?.trim() ? options.sandboxIdScope.trim() : null;
    this.#registry = options.registry;
    this.#sdk = options.sdk;
  }

  async listInstances(): Promise<SandboxInstanceSummary[]> {
    const instances = await this.#registry.getInstances();

    return instances
      .flatMap((instance) => {
        const publicId = this.#toPublicSandboxId(instance.id);
        if (!publicId) {
          return [];
        }

        return [
          {
            id: publicId,
            status: instance.status,
          },
        ];
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async startInstance(options: StartSandboxOptions): Promise<SandboxInstanceSummary> {
    const requestedSandboxId = options.id;
    const normalizedSandboxId = normalizeSandboxId(requestedSandboxId);
    const scopedSandboxId = this.#toScopedSandboxId(normalizedSandboxId);
    const parsedSleepAfter = parseSleepAfterInput(options.sleepAfter);
    if (!parsedSleepAfter.ok) {
      throw new Error(parsedSleepAfter.message);
    }

    const sandbox = this.#getSandboxHandle(scopedSandboxId, {
      keepAlive: options.keepAlive,
      sleepAfter: parsedSleepAfter.value,
    });
    let trackedInRegistry = false;

    try {
      let startupResult: CloudflareExecResult;

      try {
        startupResult = await sandbox.exec(options.startupCommand ?? "true", {
          timeout: options.startupTimeoutMs ?? 15_000,
        });
      } catch (error) {
        const failure = classifyThrownError(error);
        throw new Error(
          `Sandbox "${requestedSandboxId}" failed to start (${failure.reason}): ${failure.message}`,
          { cause: error },
        );
      }

      if (!startupResult.success) {
        const failure = classifyResultFailure(startupResult);
        throw new Error(
          `Sandbox "${requestedSandboxId}" failed startup command (${failure.reason}): ${failure.message}`,
        );
      }

      await this.#registry.trackInstance(scopedSandboxId);
      trackedInRegistry = true;

      const instance = await this.#registry.getInstance(scopedSandboxId);
      if (!instance) {
        throw new Error(
          `Sandbox "${requestedSandboxId}" started but could not be tracked in the registry.`,
        );
      }

      const publicId = this.#toPublicSandboxId(instance.id);
      if (!publicId) {
        throw new Error(
          `Sandbox "${requestedSandboxId}" was tracked outside the current organization scope.`,
        );
      }

      return {
        id: publicId,
        status: instance.status,
      };
    } catch (error) {
      await this.#cleanupFailedStart({
        sandbox,
        scopedSandboxId,
        trackedInRegistry,
      });

      if (error instanceof Error) {
        throw error;
      }

      throw new Error(`Sandbox "${requestedSandboxId}" failed to start: ${toErrorMessage(error)}`, {
        cause: error,
      });
    }
  }

  async killInstance(sandboxId: string): Promise<void> {
    const normalizedSandboxId = normalizeSandboxId(sandboxId);
    const scopedSandboxId = this.#toScopedSandboxId(normalizedSandboxId);
    const sandbox = this.#getSandboxHandle(scopedSandboxId);
    let shouldUntrack = false;

    try {
      await sandbox.destroy();
      shouldUntrack = true;
    } catch (error) {
      const failure = classifyThrownError(error);
      if (failure.reason === "sandbox_terminated") {
        shouldUntrack = true;
      } else if (failure.reason === "sandbox_unavailable") {
        return;
      } else {
        throw new Error(
          `Sandbox "${sandboxId}" failed to stop (${failure.reason}): ${failure.message}`,
          { cause: error },
        );
      }
    }

    if (shouldUntrack) {
      await this.#registry.untrackInstance(scopedSandboxId);
    }
  }

  async getHandle(sandboxId: string): Promise<SandboxHandle | null> {
    const normalizedSandboxId = normalizeSandboxId(sandboxId);
    const scopedSandboxId = this.#toScopedSandboxId(normalizedSandboxId);
    const instance = await this.#registry.getInstance(scopedSandboxId);
    if (!instance) {
      return null;
    }

    const sandbox = this.#getSandboxHandle(scopedSandboxId);
    return new CloudflareSandboxHandleProxy({
      id: normalizedSandboxId,
      sandbox,
    });
  }

  async #cleanupFailedStart(options: {
    sandbox: CloudflareSandboxHandle;
    scopedSandboxId: string;
    trackedInRegistry: boolean;
  }) {
    let destroyed = false;
    try {
      await options.sandbox.destroy();
      destroyed = true;
    } catch (error) {
      const failure = classifyThrownError(error);
      if (failure.reason === "sandbox_terminated") {
        destroyed = true;
      } else {
        console.error("Failed to destroy sandbox after startup failure", {
          sandboxId: options.scopedSandboxId,
          reason: failure.reason,
          error: failure.message,
        });
      }
    }

    if (!options.trackedInRegistry || !destroyed) {
      return;
    }

    try {
      await this.#registry.untrackInstance(options.scopedSandboxId);
    } catch (error) {
      console.error("Failed to untrack sandbox after startup failure", {
        sandboxId: options.scopedSandboxId,
        error: toErrorMessage(error),
      });
    }
  }

  #getSandboxHandle(
    sandboxId: string,
    options?: Pick<StartSandboxOptions, "keepAlive" | "sleepAfter">,
  ) {
    const sandboxOptions = stripUndefined({
      keepAlive: options?.keepAlive,
      sleepAfter: options?.sleepAfter,
    }) as CloudflareSandboxOptions;

    return this.#sdk.getSandbox(this.#sandboxNamespace, sandboxId, sandboxOptions);
  }

  #toScopedSandboxId(sandboxId: string): string {
    if (!this.#sandboxIdScope) {
      return sandboxId;
    }

    return `${this.#sandboxIdScope}${SANDBOX_SCOPE_SEPARATOR}${sandboxId}`;
  }

  #toPublicSandboxId(scopedSandboxId: string): string | null {
    if (!this.#sandboxIdScope) {
      return scopedSandboxId;
    }

    const prefix = `${this.#sandboxIdScope}${SANDBOX_SCOPE_SEPARATOR}`;
    if (!scopedSandboxId.startsWith(prefix)) {
      return null;
    }

    return scopedSandboxId.slice(prefix.length);
  }
}

class CloudflareSandboxHandleProxy implements SandboxHandle {
  readonly id: string;
  #sandbox: CloudflareSandboxHandle;

  constructor(options: { id: string; sandbox: CloudflareSandboxHandle }) {
    this.id = options.id;
    this.#sandbox = options.sandbox;
  }

  async executeCommand(
    command: string,
    options?: ExecuteSandboxCommandOptions,
  ): Promise<SandboxCommandResult> {
    try {
      const result = await this.#sandbox.exec(command, toCloudflareExecOptions(options));
      if (result.success) {
        return {
          ok: true,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode ?? 0,
        };
      }

      return classifyResultFailure(result);
    } catch (error) {
      return classifyThrownError(error);
    }
  }

  async mountBucket(
    bucket: string,
    mountPoint: string,
    options: MountBucketOptions,
  ): Promise<void> {
    await this.#sandbox.mountBucket(bucket, mountPoint, options);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    await this.#sandbox.mkdir(path, options);
  }

  async writeFile(path: string, content: string, options?: WriteFileOptions): Promise<void> {
    await this.#sandbox.writeFile(path, content, options);
  }

  async exists(path: string): Promise<FileExistsResult> {
    return this.#sandbox.exists(path);
  }
}

function classifyResultFailure(result: CloudflareExecResult): SandboxCommandFailure {
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

function toCloudflareExecOptions(options?: ExecuteSandboxCommandOptions): CloudflareExecOptions {
  if (!options) {
    return {};
  }

  return stripUndefined({
    timeout: options.timeoutMs,
  }) as CloudflareExecOptions;
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

function normalizeSandboxId(sandboxId: string): string {
  return sandboxId.trim().toLowerCase();
}
