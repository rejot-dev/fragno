import { defineWorkflow, WaitForEventTimeoutError } from "@fragno-dev/workflows/workflow";

import type { InstantiatedFragmentFromDefinition } from "@fragno-dev/core";

import type { SandboxRuntimeHandle, SandboxRuntimeProvider } from "@/sandbox/contracts";

import type { AutomationFragmentConfig, automationFragmentDefinition } from "./definition";
import type { SandboxLifecycleWorkflowParams } from "./sandboxes-storage-runtime";
import { automationFragmentSchema } from "./schema";

type AutomationFragment = InstantiatedFragmentFromDefinition<typeof automationFragmentDefinition>;

type SandboxLifecycleWorkflowConfig = Pick<AutomationFragmentConfig, "sandboxProviders"> & {
  getAutomationFragment: () => AutomationFragment | undefined;
};

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;

export const defineSandboxLifecycleWorkflow = (config: SandboxLifecycleWorkflowConfig) =>
  defineWorkflow(
    { name: "sandbox-lifecycle" },
    async (event: { payload: SandboxLifecycleWorkflowParams; instanceId: string }, step) => {
      const params = event.payload;
      const sandboxId = params.id;
      const provider = requireSandboxProvider(config, params.provider);
      const startupCommand = params.startupCommand || "true";
      const startupTimeoutMs = params.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

      const ownsSandboxBeforeStart = await step.do(
        "check sandbox lifecycle ownership before start",
        async () => {
          const fragment = requireAutomationFragment(config);
          const instance = await fragment.callServices(() =>
            fragment.services.getSandboxInstance({ id: sandboxId }),
          );
          return instance?.workflowInstanceId === event.instanceId;
        },
      );
      if (!ownsSandboxBeforeStart) {
        return { sandboxId, stopReason: "superseded" };
      }

      await step.do("mark sandbox starting", (tx) => {
        const fragment = requireAutomationFragment(config);
        tx.serviceCalls(
          () => [fragment.services.markSandboxInstanceStarting({ id: sandboxId })] as const,
        );
      });

      await step.do(
        "start sandbox runtime",
        { retries: { limit: 10, delay: "30 seconds", backoff: "exponential" } },
        async (tx) => {
          tx.onTerminalError.mutate((ctx) => {
            const uow = ctx.forSchema(automationFragmentSchema);
            uow.update("sandbox_instance", sandboxId, (b) =>
              b.set({
                status: "error",
                lastError: "Sandbox startup failed after retries.",
                updatedAt: uow.now(),
              }),
            );
          });

          const handle = await provider.getHandle(sandboxId, {
            keepAlive: params.keepAlive,
            sleepAfter: params.sleepAfter,
          });
          const result = await handle.exec(startupCommand, { timeout: startupTimeoutMs });
          if (!result.success) {
            throw new Error(
              result.stderr.trim() ||
                result.stdout.trim() ||
                `Sandbox startup command failed with exit code ${result.exitCode ?? "unknown"}.`,
            );
          }
        },
      );

      const ownsSandboxAfterStart = await step.do(
        "check sandbox lifecycle ownership after start",
        async () => {
          const fragment = requireAutomationFragment(config);
          const instance = await fragment.callServices(() =>
            fragment.services.getSandboxInstance({ id: sandboxId }),
          );
          return instance?.workflowInstanceId === event.instanceId;
        },
      );
      if (!ownsSandboxAfterStart) {
        return { sandboxId, stopReason: "superseded" };
      }

      await step.do("mark sandbox running", (tx) => {
        const fragment = requireAutomationFragment(config);
        tx.serviceCalls(
          () =>
            [
              fragment.services.markSandboxInstanceRunning({
                id: sandboxId,
                keepAlive: params.keepAlive,
                sleepAfter: params.sleepAfter,
              }),
            ] as const,
        );
      });

      let stopReason: "stop request" | "timeout";
      if (params.keepAlive || params.sleepAfter === undefined) {
        await step.waitForEvent("sandbox stop requested", { type: "sandbox.stopRequested" });
        stopReason = "stop request";
      } else {
        try {
          await step.waitForEvent("sandbox stop requested", {
            type: "sandbox.stopRequested",
            timeout: toWorkflowDuration(params.sleepAfter),
          });
          stopReason = "stop request";
        } catch (error) {
          if (!(error instanceof WaitForEventTimeoutError)) {
            throw error;
          }
          stopReason = "timeout";
        }
      }

      const ownsSandboxBeforeStop = await step.do(
        "check sandbox lifecycle ownership before stop",
        async () => {
          const fragment = requireAutomationFragment(config);
          const instance = await fragment.callServices(() =>
            fragment.services.getSandboxInstance({ id: sandboxId }),
          );
          return instance?.workflowInstanceId === event.instanceId;
        },
      );
      if (!ownsSandboxBeforeStop) {
        return { sandboxId, stopReason: "superseded" };
      }

      await step.do("mark sandbox stopping", (tx) => {
        const fragment = requireAutomationFragment(config);
        tx.serviceCalls(
          () => [fragment.services.markSandboxInstanceStopping({ id: sandboxId })] as const,
        );
      });

      await step.do(
        `stop sandbox runtime after ${stopReason}`,
        { retries: { limit: 10, delay: "30 seconds", backoff: "exponential" } },
        async (tx) => {
          tx.onTerminalError.mutate((ctx) => {
            const uow = ctx.forSchema(automationFragmentSchema);
            uow.update("sandbox_instance", sandboxId, (b) =>
              b.set({
                status: "error",
                lastError: "Sandbox stop reconciliation failed after retries.",
                updatedAt: uow.now(),
              }),
            );
          });

          await reconcileSandboxStopped(provider, sandboxId);
        },
      );

      await step.do("mark sandbox stopped", (tx) => {
        const fragment = requireAutomationFragment(config);
        tx.serviceCalls(
          () => [fragment.services.markSandboxInstanceStopped({ id: sandboxId })] as const,
        );
      });

      return { sandboxId, stopReason };
    },
  );

const requireAutomationFragment = (config: SandboxLifecycleWorkflowConfig) => {
  const fragment = config.getAutomationFragment();
  if (!fragment) {
    throw new Error("Sandbox lifecycle workflow requires the automations fragment.");
  }
  return fragment;
};

const requireSandboxProvider = (
  config: SandboxLifecycleWorkflowConfig,
  provider: string,
): SandboxRuntimeProvider => {
  const runtimeProvider = config.sandboxProviders?.[provider];
  if (!runtimeProvider) {
    throw new Error(`No sandbox provider configured for '${provider}'.`);
  }
  return runtimeProvider;
};

export const reconcileSandboxStopped = async (
  provider: SandboxRuntimeProvider,
  sandboxId: string,
) => {
  const status = await provider.getStatus(sandboxId);
  if (status === "stopped") {
    return;
  }

  let handle: SandboxRuntimeHandle;
  try {
    handle = await provider.getHandle(sandboxId);
  } catch (error) {
    if (isTerminatedError(error)) {
      return;
    }
    throw error;
  }

  try {
    await handle.destroy();
  } catch (error) {
    if (!isTerminatedError(error)) {
      throw error;
    }
  }
};

const isTerminatedError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("sandbox has been destroyed") ||
    normalized.includes("sandbox destroyed") ||
    normalized.includes("container exited") ||
    normalized.includes("instance not found") ||
    normalized.includes("no such container")
  );
};

const toWorkflowDuration = (sleepAfter: string | number) =>
  typeof sleepAfter === "number" ? `${sleepAfter}s` : sleepAfter;
