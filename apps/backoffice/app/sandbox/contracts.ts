export type SandboxInstanceStatus =
  | "requested"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "error";
export type SandboxProviderId = "cloudflare";

export const CLOUDFLARE_SANDBOX_PROVIDER = "cloudflare" satisfies SandboxProviderId;

export type SandboxInstanceSummary = {
  id: string;
  status: SandboxInstanceStatus;
};

export type StartSandboxOptions = {
  id: string;
  keepAlive?: boolean;
  sleepAfter?: string | number;
  startupTimeoutMs?: number;
  startupCommand?: string;
};

export type SandboxRuntimeHandleOptions = Pick<StartSandboxOptions, "keepAlive" | "sleepAfter">;

export type SandboxRuntimeExecOptions = {
  timeout?: number;
};

export type SandboxRuntimeExecResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type ExecuteSandboxCommandOptions = {
  timeoutMs?: number;
};

export type MountBucketOptions = {
  endpoint: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  region?: string;
  provider?: "r2" | "s3" | "gcs";
  pathStyle?: boolean;
  prefix?: string;
};

export type MkdirOptions = {
  recursive?: boolean;
};

export type WriteFileOptions = {
  encoding?: "utf-8" | "base64";
};

export type FileExistsResult = {
  exists: boolean;
};

export type SandboxCommandSuccess = {
  ok: true;
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type SandboxCommandFailureReason =
  | "command_failed"
  | "timeout"
  | "sandbox_terminated"
  | "sandbox_unavailable"
  | "internal_error";

export type SandboxCommandFailure = {
  ok: false;
  reason: SandboxCommandFailureReason;
  message: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  retryable: boolean;
};

export type SandboxCommandResult = SandboxCommandSuccess | SandboxCommandFailure;

export interface SandboxHandle {
  readonly id: string;
  executeCommand(
    command: string,
    options?: ExecuteSandboxCommandOptions,
  ): Promise<SandboxCommandResult>;
  mountBucket(bucket: string, mountPoint: string, options: MountBucketOptions): Promise<void>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  writeFile(path: string, content: string, options?: WriteFileOptions): Promise<void>;
  exists(path: string): Promise<FileExistsResult>;
}

export interface SandboxRuntimeHandle extends SandboxHandle {
  exec(command: string, options?: SandboxRuntimeExecOptions): Promise<SandboxRuntimeExecResult>;
  destroy(): Promise<void>;
  getRuntimeStatus(): Promise<{ status: SandboxInstanceStatus }>;
}

export interface SandboxRuntimeProvider {
  readonly provider: SandboxProviderId;
  getHandle(
    id: string,
    options?: SandboxRuntimeHandleOptions,
  ): SandboxRuntimeHandle | Promise<SandboxRuntimeHandle>;
  getStatus(id: string, existingHandle?: SandboxRuntimeHandle): Promise<SandboxInstanceStatus>;
}
