// sandbox tools
type SandboxCodemodeProvider = {
  /** Start a Cloudflare sandbox for the current organization. */
  startSandbox(input: SandboxStartSandboxInput): Promise<SandboxStartSandboxOutput>;
  /** List Cloudflare sandboxes for the current organization. */
  listSandboxes(input: SandboxListSandboxesInput): Promise<SandboxListSandboxesOutput>;
  /** Kill a Cloudflare sandbox for the current organization. */
  killSandbox(input: SandboxKillSandboxInput): Promise<SandboxKillSandboxOutput>;
  /** Execute a command in a Cloudflare sandbox. */
  executeCommand(input: SandboxExecuteCommandInput): Promise<SandboxExecuteCommandOutput>;
};
declare const sandbox: SandboxCodemodeProvider;

type SandboxStartSandboxInput = {
  id: string;
  keepAlive?: boolean;
  sleepAfter?: string | number;
  startupTimeoutMs?: number;
  startupCommand?: string;
};
type SandboxStartSandboxOutput = {
  id: string;
  status: "requested" | "starting" | "running" | "stopping" | "stopped" | "error";
};
type SandboxListSandboxesInput = Record<string, unknown>;
type SandboxListSandboxesOutput = {
  id: string;
  status: "requested" | "starting" | "running" | "stopping" | "stopped" | "error";
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
      reason:
        | "command_failed"
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
