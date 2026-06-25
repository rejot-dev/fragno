import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type { SandboxInstanceRecord } from "@/fragno/automation";
import {
  CLOUDFLARE_SANDBOX_PROVIDER,
  type SandboxCommandResult,
  type SandboxInstanceSummary,
  type SandboxProviderId,
  type SandboxRuntimeProvider,
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
    input: StartSandboxOptions & {
      provider: SandboxProviderId;
      ownerScope?: BackofficeContextScope;
    },
  ): Promise<SandboxInstanceRecord>;
  requestSandboxInstanceStop(input: {
    id: string;
    ownerScope?: BackofficeContextScope;
  }): Promise<SandboxInstanceRecord | null>;
};

export type SandboxRuntime = {
  listSandboxes(): Promise<SandboxInstanceSummary[]>;
  startSandbox(input: StartSandboxOptions): Promise<SandboxInstanceSummary>;
  killSandbox(input: SandboxKillArgs): Promise<SandboxKillResult>;
  executeCommand(input: SandboxExecuteCommandArgs): Promise<SandboxCommandResult>;
};

export const createSandboxRuntime = ({
  lifecycle,
  ownerScope,
  provider,
  sandboxIdScope,
}: {
  lifecycle: SandboxLifecycle;
  provider: SandboxRuntimeProvider;
  ownerScope?: BackofficeContextScope;
  sandboxIdScope?: string;
}): SandboxRuntime => {
  const normalizedScope = sandboxIdScope?.trim() || null;
  const scopedId = (sandboxId: string) =>
    normalizedScope
      ? `${normalizedScope}::${normalizeSandboxId(sandboxId)}`
      : normalizeSandboxId(sandboxId);
  const publicId = (sandboxId: string) => {
    if (!normalizedScope) {
      return sandboxId;
    }

    const prefix = `${normalizedScope}::`;
    return sandboxId.startsWith(prefix) ? sandboxId.slice(prefix.length) : null;
  };

  return {
    listSandboxes: async () => {
      const instances = await lifecycle.listSandboxInstances({
        provider: CLOUDFLARE_SANDBOX_PROVIDER,
      });
      return instances
        .flatMap((instance) => {
          const id = publicId(instance.id);
          return id ? [{ id, status: instance.status }] : [];
        })
        .sort((a, b) => a.id.localeCompare(b.id));
    },
    startSandbox: async (input) => {
      const parsedSleepAfter = parseSleepAfterInput(input.sleepAfter);
      if (!parsedSleepAfter.ok) {
        throw new Error(parsedSleepAfter.message);
      }

      const instance = await lifecycle.requestSandboxInstance({
        id: scopedId(input.id),
        provider: CLOUDFLARE_SANDBOX_PROVIDER,
        keepAlive: input.keepAlive,
        sleepAfter: parsedSleepAfter.value,
        startupCommand: input.startupCommand || "true",
        startupTimeoutMs: input.startupTimeoutMs,
        ownerScope,
      });
      const id = publicId(instance.id);
      if (!id) {
        throw new Error(`Sandbox "${input.id}" was requested outside the current scope.`);
      }
      return { id, status: instance.status };
    },
    killSandbox: async ({ sandboxId }) => {
      await lifecycle.requestSandboxInstanceStop({ id: scopedId(sandboxId), ownerScope });
      return { sandboxId: normalizeSandboxId(sandboxId), killed: true };
    },
    executeCommand: async ({ sandboxId, command, timeoutMs }) => {
      const id = normalizeSandboxId(sandboxId);
      const instance = await lifecycle.getSandboxInstance({ id: scopedId(id) });
      if (instance?.status !== "running") {
        return {
          ok: false,
          reason: "sandbox_unavailable",
          message: `Sandbox "${id}" is unavailable.`,
          retryable: true,
        };
      }

      const handle = await provider.getHandle(scopedId(id));
      return await handle.executeCommand(command, { timeoutMs });
    },
  };
};

function normalizeSandboxId(sandboxId: string): string {
  return sandboxId.trim().toLowerCase();
}
