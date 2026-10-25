// Cloudflare sandboxes with a real shell. Read when work needs command-line tools.
type SandboxCodemodeProvider = {
  /**
   * Start a Cloudflare sandbox for the current organization.
   * Requires `sandbox.modify`.
   */
  startSandbox(input: SandboxStartSandboxInput): Promise<SandboxStartSandboxOutput>;
  /**
   * List Cloudflare sandboxes for the current organization.
   * Requires `sandbox.read`.
   */
  listSandboxes(): Promise<SandboxListSandboxesOutput>;
  /**
   * Save a Cloudflare sandbox's workspace and stop it. Starting the same sandbox ID resumes the workspace.
   * Requires `sandbox.modify`.
   */
  killSandbox(input: SandboxKillSandboxInput): Promise<SandboxKillSandboxOutput>;
  /**
   * Execute a command in a Cloudflare sandbox.
   * Requires `sandbox.modify`.
   */
  executeCommand(input: SandboxExecuteCommandInput): Promise<SandboxExecuteCommandOutput>;
};
declare const sandbox: SandboxCodemodeProvider;

type SandboxStartSandboxInput = {
  id: string;
  keepAlive?: boolean;
  /** Saves the workspace and stops the sandbox after this long, for example 15m. Defaults to 10m unless keepAlive is set. */
  sleepAfter?: string | number;
  startupTimeoutMs?: number;
  startupCommand?: string;
  /** Image for a new workspace; defaults to workspace. A saved workspace resumes on its own image. */
  image?: "workspace" | "debian";
  instanceType?: "lite" | "standard-1" | "standard-2" | "standard-3" | "standard-4";
};
type SandboxStartSandboxOutput = {
  id: string;
  status: "requested" | "starting" | "running" | "stopping" | "stopped" | "error";
  /** workspace: Debian with Node.js, Python, git, ripgrep, and jq. debian: Cloudflare-managed Debian with Node.js; starts fastest. */
  image: "workspace" | "debian";
  instanceType: "lite" | "standard-1" | "standard-2" | "standard-3" | "standard-4";
  /** Whether the next start resumes the workspace saved when the sandbox last stopped. */
  workspaceSaved: boolean;
};
type SandboxListSandboxesOutput = {
  id: string;
  status: "requested" | "starting" | "running" | "stopping" | "stopped" | "error";
  /** workspace: Debian with Node.js, Python, git, ripgrep, and jq. debian: Cloudflare-managed Debian with Node.js; starts fastest. */
  image: "workspace" | "debian";
  instanceType: "lite" | "standard-1" | "standard-2" | "standard-3" | "standard-4";
  /** Whether the next start resumes the workspace saved when the sandbox last stopped. */
  workspaceSaved: boolean;
}[];
type SandboxKillSandboxInput = {
  sandboxId: string;
};
type SandboxKillSandboxOutput = {
  sandboxId: string;
  killed: true;
};
type SandboxExecuteCommandInput = {
  sandboxId: string;
  command: string;
  timeoutMs?: number;
};
type SandboxExecuteCommandOutput =
  | {
      ok: true;
      stdout: string;
      stderr: string;
      exitCode: number;
    }
  | {
      ok: false;
      code: string;
      reason:
        | "authentication_failed"
        | "command_failed"
        | "invalid_request"
        | "output_limit_exceeded"
        | "timeout"
        | "sandbox_terminated"
        | "sandbox_unavailable"
        | "internal_error";
      message: string;
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      retryable: boolean;
    };
