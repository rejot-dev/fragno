import {
  defineWorkflow,
  NonRetryableError,
  WaitForEventTimeoutError,
} from "@fragno-dev/workflows/workflow";

import type { InstantiatedFragmentFromDefinition } from "@fragno-dev/core";
import type { HandlerTxContext, HooksMap } from "@fragno-dev/db";

import type { SandboxRuntimeProvider } from "@/sandbox/contracts";
import { executeSandboxCommand } from "@/sandbox/sandbox-command-result";
import { SandboxRuntimeError } from "@/sandbox/sandbox-runtime-error";
import { sleepAfterToMilliseconds } from "@/sandbox/sleep-after";

import type { SandboxLifecycleWorkflowParams } from "./contracts";
import type { SandboxManagerFragmentConfig, sandboxManagerFragmentDefinition } from "./definition";
import { sandboxManagerFragmentSchema } from "./schema";
import { sandboxWorkspaceSnapshotExpiresAt } from "./workspace-snapshot";

type SandboxManagerFragment = Pick<
  InstantiatedFragmentFromDefinition<typeof sandboxManagerFragmentDefinition>,
  "callServices" | "services"
>;

type SandboxLifecycleWorkflowConfig = Pick<SandboxManagerFragmentConfig, "sandboxProviders"> & {
  getSandboxManagerFragment: () => SandboxManagerFragment | undefined;
};

// The sandbox stops itself this long after the manager should have stopped it.
const SANDBOX_LEASE_GRACE_MS = 60 * 60 * 1000;

export const defineSandboxLifecycleWorkflow = (config: SandboxLifecycleWorkflowConfig) =>
  defineWorkflow(
    { name: "sandbox-lifecycle", checkpoint: "step" },
    async (event: { payload: SandboxLifecycleWorkflowParams; instanceId: string }, step) => {
      const params = event.payload;
      const sandboxId = params.id;
      const provider = requireSandboxProvider(config, params.provider);
      const runsUntilStopped = params.keepAlive || params.sleepAfter === null;

      function recordStartupFailure(ctx: HandlerTxContext<HooksMap>, cause: unknown) {
        recordSandboxLifecycleFailure(ctx, {
          sandboxId,
          params,
          eventId: `${event.instanceId}:failed:start`,
          message:
            params.source.kind === "snapshot"
              ? "Sandbox startup failed after retries. Its saved workspace is kept for the next start."
              : "Sandbox startup failed after retries.",
          cause,
        });
      }

      const ownsSandboxBeforeStart = await step.do(
        "check sandbox lifecycle ownership before start",
        async () => await ownsSandbox(config, sandboxId, event.instanceId),
      );
      if (!ownsSandboxBeforeStart) {
        return { sandboxId, stopReason: "superseded" };
      }

      await step.do("mark sandbox starting", (tx) => {
        const fragment = requireSandboxManagerFragment(config);
        tx.serviceCalls(
          () => [fragment.services.markSandboxInstanceStarting({ id: sandboxId })] as const,
        );
      });

      await step.do(
        "start sandbox runtime",
        { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
        async (tx) => {
          // Terminal-error mutations run after the failed attempt, so they see its cause.
          let cause: unknown = null;
          tx.onTerminalError.mutate((ctx) => {
            recordStartupFailure(ctx, cause);
          });

          try {
            const sandbox = await provider.getHandle(sandboxId);
            const outcome = await sandbox.start({
              source: params.source,
              instanceType: params.instanceType,
              leaseExpiresAt: runsUntilStopped
                ? null
                : Date.now() +
                  sleepAfterToMilliseconds(params.sleepAfter ?? 0) +
                  SANDBOX_LEASE_GRACE_MS,
            });
            const restoration = outcome.restoredSnapshot;
            if (restoration !== null) {
              const fragment = requireSandboxManagerFragment(config);
              // This transaction reads the current snapshot, so it cannot use the mutate-only
              // step buffer. Repeated attempts renew from the same confirmed restoration time.
              await fragment.callServices(() =>
                fragment.services.renewSandboxWorkspaceSnapshot({
                  id: sandboxId,
                  workflowInstanceId: event.instanceId,
                  snapshotId: restoration.id,
                  restoredAt: restoration.restoredAt,
                }),
              );
            }
          } catch (error) {
            cause = error;
            throwSandboxLifecycleOperationError(error);
          }
        },
      );

      // Commit restored snapshot retention before a startup command can fail or suspend for retry.
      await step.do(
        "run sandbox startup command",
        { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
        async (tx) => {
          let cause: unknown = null;
          tx.onTerminalError.mutate((ctx) => {
            recordStartupFailure(ctx, cause);
          });
          try {
            const sandbox = await provider.getHandle(sandboxId);
            const result = await executeSandboxCommand(sandbox, params.startupCommand, {
              timeoutMs: params.startupTimeoutMs,
            });
            if (!result.ok) {
              throw result.retryable
                ? new Error(result.message)
                : new NonRetryableError(result.message);
            }
          } catch (error) {
            cause = error;
            throwSandboxLifecycleOperationError(error);
          }
        },
      );

      const ownsSandboxAfterStart = await step.do(
        "check sandbox lifecycle ownership after start",
        async () => await ownsSandbox(config, sandboxId, event.instanceId),
      );
      if (!ownsSandboxAfterStart) {
        return { sandboxId, stopReason: "superseded" };
      }

      await step.do("mark sandbox running", (tx) => {
        const fragment = requireSandboxManagerFragment(config);
        tx.serviceCalls(
          () =>
            [
              fragment.services.markSandboxInstanceRunning({
                id: sandboxId,
                provider: params.provider,
                workflowInstanceId: event.instanceId,
                keepAlive: params.keepAlive,
                sleepAfter: params.sleepAfter,
              }),
            ] as const,
        );
      });

      let stopReason: "stop request" | "timeout";
      if (runsUntilStopped) {
        await step.waitForEvent("sandbox stop requested", { type: "sandbox.stopRequested" });
        stopReason = "stop request";
      } else {
        try {
          await step.waitForEvent("sandbox stop requested", {
            type: "sandbox.stopRequested",
            timeout: toWorkflowDuration(params.sleepAfter ?? 0),
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
        async () => await ownsSandbox(config, sandboxId, event.instanceId),
      );
      if (!ownsSandboxBeforeStop) {
        return { sandboxId, stopReason: "superseded" };
      }

      await step.do("mark sandbox stopping", (tx) => {
        const fragment = requireSandboxManagerFragment(config);
        tx.serviceCalls(
          () =>
            [
              fragment.services.markSandboxInstanceStopping({
                id: sandboxId,
                provider: params.provider,
                workflowInstanceId: event.instanceId,
                keepAlive: params.keepAlive,
                sleepAfter: params.sleepAfter,
              }),
            ] as const,
        );
      });

      // A container that already stopped has nothing newer than the workspace saved before it.
      await step.do(
        "save sandbox workspace",
        { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
        async (tx) => {
          let cause: unknown = null;
          tx.onTerminalError.mutate((ctx) => {
            recordSandboxLifecycleFailure(ctx, {
              sandboxId,
              params,
              eventId: `${event.instanceId}:failed:save`,
              message: "Sandbox workspace could not be saved after retries.",
              cause,
            });
          });

          const outcome = await provider
            .getHandle(sandboxId)
            .then(async (sandbox) => await sandbox.snapshot())
            .catch((error: unknown): never => {
              cause = error;
              throwSandboxLifecycleOperationError(error);
            });
          if (outcome.status === "saved") {
            const fragment = requireSandboxManagerFragment(config);
            const expiresAt = sandboxWorkspaceSnapshotExpiresAt(new Date().toISOString());
            tx.serviceCalls(
              () =>
                [
                  fragment.services.recordSandboxWorkspaceSnapshot({
                    id: sandboxId,
                    workspaceSnapshot: { ...outcome.snapshot, expiresAt },
                  }),
                ] as const,
            );
          }
        },
      );

      await step.do(
        `stop sandbox runtime after ${stopReason}`,
        { retries: { limit: 10, delay: "30 seconds", backoff: "exponential" } },
        async (tx) => {
          let cause: unknown = null;
          tx.onTerminalError.mutate((ctx) => {
            recordSandboxLifecycleFailure(ctx, {
              sandboxId,
              params,
              eventId: `${event.instanceId}:failed:stop`,
              message: "Sandbox stop reconciliation failed after retries.",
              cause,
            });
          });

          try {
            await (await provider.getHandle(sandboxId)).stop();
          } catch (error) {
            cause = error;
            throwSandboxLifecycleOperationError(error);
          }
        },
      );

      await step.do("mark sandbox stopped", (tx) => {
        const fragment = requireSandboxManagerFragment(config);
        tx.serviceCalls(
          () =>
            [
              fragment.services.markSandboxInstanceStopped({
                id: sandboxId,
                provider: params.provider,
                workflowInstanceId: event.instanceId,
                keepAlive: params.keepAlive,
                sleepAfter: params.sleepAfter,
              }),
            ] as const,
        );
      });

      return { sandboxId, stopReason };
    },
  );

function requireSandboxManagerFragment(config: SandboxLifecycleWorkflowConfig) {
  const fragment = config.getSandboxManagerFragment();
  if (!fragment) {
    throw new Error("Sandbox lifecycle workflow requires the sandbox manager fragment.");
  }
  return fragment;
}

async function ownsSandbox(
  config: SandboxLifecycleWorkflowConfig,
  sandboxId: string,
  workflowInstanceId: string,
): Promise<boolean> {
  const fragment = requireSandboxManagerFragment(config);
  const instance = await fragment.callServices(() =>
    fragment.services.getSandboxInstance({ id: sandboxId }),
  );
  return instance?.workflowInstanceId === workflowInstanceId;
}

function requireSandboxProvider(
  config: SandboxLifecycleWorkflowConfig,
  provider: string,
): SandboxRuntimeProvider {
  const runtimeProvider = config.sandboxProviders?.[provider];
  if (!runtimeProvider) {
    throw new Error(`No sandbox provider configured for '${provider}'.`);
  }
  return runtimeProvider;
}

/** Marks the sandbox failed and tells Automations, committed only when a lifecycle step gives up. */
function recordSandboxLifecycleFailure(
  ctx: HandlerTxContext<HooksMap>,
  input: {
    sandboxId: string;
    params: SandboxLifecycleWorkflowParams;
    eventId: string;
    message: string;
    /** What the last attempt threw; null when the step failed outside the provider call. */
    cause: unknown;
  },
) {
  const message =
    input.cause === null
      ? input.message
      : `${input.message} Cause: ${describeSandboxLifecycleCause(input.cause)}`;
  const uow = ctx.forSchema(sandboxManagerFragmentSchema);
  uow.update("sandbox_instance", input.sandboxId, (b) =>
    b.set({ status: "error", lastError: message, updatedAt: uow.now() }),
  );
  uow.triggerHook(
    "deliverLifecycleEvent",
    {
      id: input.eventId,
      type: "failed",
      sandboxId: input.sandboxId,
      provider: input.params.provider,
      status: "error",
      reason: "terminal_error",
      error: { message },
    },
    { id: input.eventId },
  );
}

function describeSandboxLifecycleCause(cause: unknown) {
  if (cause instanceof SandboxRuntimeError) {
    return `[${cause.code}] ${cause.message}`;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

function throwSandboxLifecycleOperationError(error: unknown): never {
  if (error instanceof SandboxRuntimeError && !error.retryable) {
    throw new NonRetryableError(`[${error.code}] ${error.message}`);
  }
  throw error;
}

function toWorkflowDuration(sleepAfter: string | number) {
  return typeof sleepAfter === "number" ? `${sleepAfter}s` : sleepAfter;
}
