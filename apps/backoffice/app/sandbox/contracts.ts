import type {
  SandboxContainerControl,
  SandboxImage,
  SandboxInstanceType,
} from "@fragno-apps/cf-sandbox-bridge/sandbox/sandbox-container-contract";

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
  image: SandboxImage;
  instanceType: SandboxInstanceType;
  /** Whether the next start resumes the workspace saved when the sandbox last stopped. */
  workspaceSaved: boolean;
};

export type StartSandboxOptions = {
  id: string;
  keepAlive?: boolean;
  sleepAfter?: string | number;
  startupTimeoutMs?: number;
  startupCommand?: string;
  /** Applies to a new workspace; a saved workspace resumes on the image it was created from. */
  image?: SandboxImage;
  instanceType?: SandboxInstanceType;
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
  | "authentication_failed"
  | "command_failed"
  | "invalid_request"
  | "output_limit_exceeded"
  | "timeout"
  | "sandbox_terminated"
  | "sandbox_unavailable"
  | "internal_error";

export type SandboxCommandFailure = {
  ok: false;
  code: string;
  reason: SandboxCommandFailureReason;
  message: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  retryable: boolean;
};

export type SandboxCommandResult = SandboxCommandSuccess | SandboxCommandFailure;

export interface SandboxRuntimeProvider {
  readonly provider: SandboxProviderId;
  getHandle(id: string): Promise<SandboxContainerControl>;
}

/** Sandbox runtime providers scoped to one Backoffice sandbox manager identity. */
export type SandboxRuntimeProviders = Readonly<Record<string, SandboxRuntimeProvider>>;

/** Creates provider adapters whose physical sandbox IDs are isolated to one manager. */
export type CreateSandboxRuntimeProviders = (managerId: string) => SandboxRuntimeProviders;
