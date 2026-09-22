import type { SandboxInstanceRecord } from "@/fragno/sandbox-manager/contracts";
import {
  CLOUDFLARE_SANDBOX_PROVIDER,
  type SandboxCommandResult,
  type SandboxInstanceSummary,
  type SandboxProviderId,
  type StartSandboxOptions,
} from "@/sandbox/contracts";
import { parseSleepAfterInput } from "@/sandbox/sleep-after";

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

type SandboxLifecycle = {
  listSandboxInstances(input?: { provider?: SandboxProviderId }): Promise<SandboxInstanceRecord[]>;
  getSandboxInstance(input: { id: string }): Promise<SandboxInstanceRecord | null>;
  requestSandboxInstance(
    input: StartSandboxOptions & { provider: SandboxProviderId },
  ): Promise<SandboxInstanceRecord>;
  requestSandboxInstanceStop(input: { id: string }): Promise<SandboxInstanceRecord | null>;
  executeSandboxCommand(input: SandboxExecuteCommandArgs): Promise<SandboxCommandResult>;
};

export type SandboxRuntime = {
  listSandboxes(): Promise<SandboxInstanceSummary[]>;
  startSandbox(input: StartSandboxOptions): Promise<SandboxInstanceSummary>;
  killSandbox(input: SandboxKillArgs): Promise<SandboxKillResult>;
  executeCommand(input: SandboxExecuteCommandArgs): Promise<SandboxCommandResult>;
};

export const createSandboxRuntime = ({
  lifecycle,
}: {
  lifecycle: SandboxLifecycle;
}): SandboxRuntime => {
  return {
    listSandboxes: async () => {
      const instances = await lifecycle.listSandboxInstances({
        provider: CLOUDFLARE_SANDBOX_PROVIDER,
      });
      return instances
        .map((instance) => ({ id: instance.id, status: instance.status }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },
    startSandbox: async (input) => {
      const parsedSleepAfter = parseSleepAfterInput(input.sleepAfter);
      if (!parsedSleepAfter.ok) {
        throw new Error(parsedSleepAfter.message);
      }

      const instance = await lifecycle.requestSandboxInstance({
        id: normalizeSandboxId(input.id),
        provider: CLOUDFLARE_SANDBOX_PROVIDER,
        keepAlive: input.keepAlive,
        sleepAfter: parsedSleepAfter.value,
        startupCommand: input.startupCommand || "true",
        startupTimeoutMs: input.startupTimeoutMs,
      });
      return { id: instance.id, status: instance.status };
    },
    killSandbox: async ({ sandboxId }) => {
      await lifecycle.requestSandboxInstanceStop({ id: normalizeSandboxId(sandboxId) });
      return { sandboxId: normalizeSandboxId(sandboxId), killed: true };
    },
    executeCommand: async ({ sandboxId, command, timeoutMs }) =>
      await lifecycle.executeSandboxCommand({
        sandboxId: normalizeSandboxId(sandboxId),
        command,
        timeoutMs,
      }),
  };
};

function normalizeSandboxId(sandboxId: string): string {
  return sandboxId.trim().toLowerCase();
}
