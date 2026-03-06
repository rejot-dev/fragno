export type SandboxInstanceStatus = "running" | "stopped" | "error";

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

export type ExecuteSandboxCommandOptions = {
  timeoutMs?: number;
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
}

export interface SandboxManager {
  listInstances(): Promise<SandboxInstanceSummary[]>;
  startInstance(options: StartSandboxOptions): Promise<SandboxInstanceSummary>;
  killInstance(sandboxId: string): Promise<void>;
  getHandle(sandboxId: string): Promise<SandboxHandle | null>;
}
