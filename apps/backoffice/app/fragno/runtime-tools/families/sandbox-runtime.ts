import type {
  SandboxCommandResult,
  SandboxInstanceSummary,
  SandboxManager,
  StartSandboxOptions,
} from "@/sandbox/contracts";

export type SandboxExecuteCommandArgs = {
  sandboxId: string;
  command: string;
  timeoutMs?: number;
};

export type SandboxKillArgs = {
  sandboxId: string;
};

export type SandboxKillResult = {
  sandboxId: string;
  killed: true;
};

export type SandboxRuntime = {
  listSandboxes(): Promise<SandboxInstanceSummary[]>;
  startSandbox(input: StartSandboxOptions): Promise<SandboxInstanceSummary>;
  killSandbox(input: SandboxKillArgs): Promise<SandboxKillResult>;
  executeCommand(input: SandboxExecuteCommandArgs): Promise<SandboxCommandResult>;
};

export const createSandboxRuntime = (manager: SandboxManager): SandboxRuntime => ({
  listSandboxes: async () => await manager.listInstances(),
  startSandbox: async (input) => await manager.startInstance(input),
  killSandbox: async ({ sandboxId }) => {
    await manager.killInstance(sandboxId);
    return { sandboxId, killed: true };
  },
  executeCommand: async ({ sandboxId, command, timeoutMs }) => {
    const handle = await manager.getHandle(sandboxId);
    if (!handle) {
      return {
        ok: false,
        reason: "sandbox_unavailable",
        message: `Sandbox "${sandboxId}" is unavailable.`,
        retryable: true,
      };
    }

    return await handle.executeCommand(command, { timeoutMs });
  },
});
