import type {
  SandboxImage,
  SandboxInstanceType,
  SandboxStartSource,
} from "@fragno-apps/cf-sandbox-bridge/sandbox/sandbox-container-contract";

import type { DatabaseServiceContext, TypedUnitOfWork } from "@fragno-dev/db";
import type { WorkflowsFragmentServices } from "@fragno-dev/workflows";

import type { SandboxRuntimeProvider } from "@/sandbox/contracts";
import { sleepAfterToMilliseconds } from "@/sandbox/sleep-after";

import {
  CLOUDFLARE_SANDBOX_PROVIDER,
  sandboxInstanceListInputSchema,
  sandboxInstanceLookupInputSchema,
  sandboxInstanceMarkErrorInputSchema,
  sandboxInstanceMarkRunningInputSchema,
  sandboxInstanceMarkStartingInputSchema,
  sandboxInstanceMarkStoppedInputSchema,
  sandboxInstanceMarkStoppingInputSchema,
  sandboxInstanceRecordWorkspaceSnapshotInputSchema,
  sandboxInstanceRenewWorkspaceSnapshotInputSchema,
  sandboxInstanceRequestInputSchema,
  sandboxInstanceSchema,
  sandboxInstanceStopRequestInputSchema,
  sandboxInstanceWorkflowLookupInputSchema,
  type SandboxInstanceListInput,
  type SandboxInstanceLookupInput,
  type SandboxInstanceWorkflowLookupInput,
  type SandboxInstanceMarkErrorInput,
  type SandboxInstanceMarkRunningInput,
  type SandboxInstanceMarkStartingInput,
  type SandboxInstanceMarkStoppedInput,
  type SandboxInstanceMarkStoppingInput,
  type SandboxInstanceRecordWorkspaceSnapshotInput,
  type SandboxInstanceRenewWorkspaceSnapshotInput,
  type SandboxInstanceRequestInput,
  type SandboxInstanceStopRequestInput,
  type SandboxUsage,
} from "./contracts";
import type { MeterSandboxUsagePayload, SandboxManagerInternalHooks } from "./internal-hooks";
import { sandboxManagerFragmentSchema, type SandboxWorkspaceSnapshot } from "./schema";
import {
  isSandboxWorkspaceSnapshotResumable,
  sandboxWorkspaceSnapshotExpiresAt,
} from "./workspace-snapshot";

export const SANDBOX_LIFECYCLE_WORKFLOW_NAME = "sandbox-lifecycle" as const;

const DEFAULT_SANDBOX_IMAGE: SandboxImage = "workspace";
const DEFAULT_SANDBOX_INSTANCE_TYPE: SandboxInstanceType = "lite";
// Containers run until their manager stops them, so a sandbox needs keepAlive to run indefinitely.
const DEFAULT_SANDBOX_SLEEP_AFTER = "10m";
const DEFAULT_SANDBOX_STARTUP_TIMEOUT_MS = 15_000;

type SandboxManagerServicesOptions = {
  workflows: Pick<WorkflowsFragmentServices, "createInstance" | "getInstanceStatus" | "sendEvent">;
  sandboxProviders?: Record<string, SandboxRuntimeProvider>;
};

// Bills running sandboxes at least hourly, so usage statements stay current while they run.
const SANDBOX_USAGE_CHECKPOINT_INTERVAL_MS = 60 * 60 * 1000;

type SandboxManagerUnitOfWork = TypedUnitOfWork<
  typeof sandboxManagerFragmentSchema,
  [],
  unknown,
  SandboxManagerInternalHooks
>;

const ACTIVE_SANDBOX_INSTANCE_STATUSES = new Set(["requested", "starting", "running", "stopping"]);
const TERMINAL_WORKFLOW_STATUSES = new Set(["complete", "errored", "terminated"]);

export function createSandboxManagerServices(
  defineService: <TService>(
    service: TService & ThisType<DatabaseServiceContext<SandboxManagerInternalHooks>>,
  ) => TService,
  options: SandboxManagerServicesOptions,
) {
  return defineService({
    listSandboxInstances(args?: SandboxInstanceListInput) {
      const input = sandboxInstanceListInputSchema.parse(args) ?? {};
      return this.serviceTx(sandboxManagerFragmentSchema)
        .retrieve((uow) =>
          uow.find("sandbox_instance", (b) => {
            const query = input.provider
              ? b.whereIndex("idx_sandbox_instance_provider", (eb) =>
                  eb("provider", "=", input.provider!),
                )
              : b.whereIndex("primary");
            return input.limit ? query.pageSize(input.limit) : query;
          }),
        )
        .transformRetrieve(([instances]) =>
          instances.map((instance) => sandboxInstanceSchema.parse(instance)),
        )
        .build();
    },

    getSandboxInstance(args: SandboxInstanceLookupInput) {
      const input = sandboxInstanceLookupInputSchema.parse(args);
      return this.serviceTx(sandboxManagerFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("sandbox_instance", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", input.id)),
          ),
        )
        .transformRetrieve(([instance]) =>
          instance ? sandboxInstanceSchema.parse(instance) : null,
        )
        .build();
    },

    /**
     * Ends billing and stops the container of a lifecycle that ended without stopping them, such
     * as one that failed or was superseded. Billing ends even when the stop fails, whose error is
     * thrown after the commit so the caller retries the stop.
     */
    stopSandboxInstanceForTerminalWorkflow(args: SandboxInstanceWorkflowLookupInput) {
      const input = sandboxInstanceWorkflowLookupInputSchema.parse(args);
      return this.serviceTx(sandboxManagerFragmentSchema)
        .retrieve((uow) =>
          uow
            .findFirst("sandbox_instance", (b) =>
              b.whereIndex("idx_sandbox_instance_workflowInstanceId", (eb) =>
                eb("workflowInstanceId", "=", input.workflowInstanceId),
              ),
            )
            .findFirst("sandbox_usage_meter", (b) =>
              b
                .whereIndex("primary", (eb) => eb("id", "=", input.workflowInstanceId))
                .select(["id", "stoppedAt"]),
            ),
        )
        .transformRetrieve(
          async ([instance, meter]): Promise<{
            instance: typeof instance;
            meterRunning: boolean;
            stop: { outcome: "skipped" | "stopped" } | { outcome: "failed"; error: unknown };
          }> => {
            const meterRunning = meter?.stoppedAt === null;
            if (!instance || instance.status === "stopped") {
              return { instance, meterRunning, stop: { outcome: "skipped" } };
            }
            try {
              const provider = options.sandboxProviders?.[instance.provider];
              if (!provider) {
                throw new Error(`No sandbox provider configured for '${instance.provider}'.`);
              }
              await (await provider.getHandle(String(instance.id))).stop();
              return { instance, meterRunning, stop: { outcome: "stopped" } };
            } catch (error) {
              return { instance, meterRunning, stop: { outcome: "failed", error } };
            }
          },
        )
        .mutate(({ uow, retrieveResult: { instance, meterRunning, stop } }) => {
          if (meterRunning) {
            stopSandboxUsageMeter(uow, input.workflowInstanceId);
          }
          if (!instance) {
            return null;
          }
          if (stop.outcome !== "stopped") {
            return instance;
          }

          const now = uow.now();
          const next = {
            ...instance,
            status: instance.status === "error" ? instance.status : ("stopped" as const),
            stoppedAt: now,
            updatedAt: now,
          };
          uow.update("sandbox_instance", instance.id, (b) =>
            b.set({ status: next.status, stoppedAt: next.stoppedAt, updatedAt: now }).check(),
          );
          if (next.status === "stopped") {
            uow.triggerHook(
              "deliverLifecycleEvent",
              {
                id: `${input.workflowInstanceId}:stopped:workflow-terminal`,
                type: "stopped",
                sandboxId: String(instance.id),
                provider: CLOUDFLARE_SANDBOX_PROVIDER,
                status: "stopped",
                reason: "workflow_terminal",
              },
              { id: `${input.workflowInstanceId}:stopped:workflow-terminal` },
            );
          }
          return next;
        })
        .transform(({ retrieveResult: { stop }, mutateResult }) => {
          if (stop.outcome === "failed") {
            throw stop.error;
          }
          return mutateResult ? sandboxInstanceSchema.parse(mutateResult) : null;
        })
        .build();
    },

    requestSandboxInstance(args: SandboxInstanceRequestInput) {
      const input = sandboxInstanceRequestInputSchema.parse(args);
      const workflowInstanceId = `inst_${crypto.randomUUID()}`;
      const keepAlive = input.keepAlive ?? false;
      const sleepAfter = input.sleepAfter ?? (keepAlive ? null : DEFAULT_SANDBOX_SLEEP_AFTER);
      const startupCommand = input.startupCommand || "true";
      const startupTimeoutMs = input.startupTimeoutMs ?? DEFAULT_SANDBOX_STARTUP_TIMEOUT_MS;

      return this.serviceTx(sandboxManagerFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("sandbox_instance", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", input.id)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing] }) => {
          if (existing && ACTIVE_SANDBOX_INSTANCE_STATUSES.has(existing.status)) {
            return existing;
          }

          const workspace = resolveSandboxWorkspace(
            input.id,
            existing ?? null,
            input.image,
            Date.now(),
          );
          const instanceType =
            input.instanceType ?? existing?.instanceType ?? DEFAULT_SANDBOX_INSTANCE_TYPE;
          const now = uow.now();
          const next = {
            id: input.id,
            provider: input.provider,
            status: "requested" as const,
            workflowInstanceId,
            keepAlive,
            sleepAfter,
            startupCommand,
            startupTimeoutMs,
            image: workspace.image,
            instanceType,
            workspaceSnapshot: workspace.snapshot,
            startedAt: null,
            expectedStopAt: null,
            stoppedAt: null,
            lastError: null,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          };

          uow.triggerHook(
            "enqueueSandboxLifecycleWorkflow",
            {
              workflowInstanceId,
              params: {
                id: input.id,
                provider: input.provider,
                keepAlive,
                sleepAfter,
                startupCommand,
                startupTimeoutMs,
                instanceType,
                source: workspace.source,
              },
            },
            { id: workflowInstanceId },
          );

          if (existing) {
            uow.update("sandbox_instance", existing.id, (b) =>
              b
                .set({
                  provider: next.provider,
                  status: next.status,
                  workflowInstanceId: next.workflowInstanceId,
                  keepAlive: next.keepAlive,
                  sleepAfter: next.sleepAfter,
                  startupCommand: next.startupCommand,
                  startupTimeoutMs: next.startupTimeoutMs,
                  image: next.image,
                  instanceType: next.instanceType,
                  workspaceSnapshot: next.workspaceSnapshot,
                  startedAt: null,
                  expectedStopAt: null,
                  stoppedAt: null,
                  lastError: null,
                  updatedAt: now,
                })
                .check(),
            );
            return { ...existing, ...next };
          }

          uow.create("sandbox_instance", next);
          return next;
        })
        .transform(({ mutateResult }) => sandboxInstanceSchema.parse(mutateResult))
        .build();
    },

    requestSandboxInstanceStop(args: SandboxInstanceStopRequestInput) {
      const input = sandboxInstanceStopRequestInputSchema.parse(args);
      const workflows = options.workflows;
      const stopRequestedEvent = {
        type: "sandbox.stopRequested",
        payload: { sandboxId: input.id },
        ignoreTerminal: true,
      } satisfies Parameters<WorkflowsFragmentServices["sendEvent"]>[2] & {
        ignoreTerminal: true;
      };

      return this.serviceTx(sandboxManagerFragmentSchema)
        .withServiceCalls(
          () =>
            [
              workflows.sendEvent(
                SANDBOX_LIFECYCLE_WORKFLOW_NAME,
                input.workflowInstanceId,
                stopRequestedEvent,
              ),
            ] as const,
        )
        .retrieve((uow) =>
          uow.findFirst("sandbox_instance", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", input.id)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing], serviceIntermediateResult: [workflow] }) => {
          if (!existing) {
            return null;
          }

          const [workflowInstance] = workflow;
          const now = uow.now();
          const isTerminalWorkflow = workflowInstance
            ? TERMINAL_WORKFLOW_STATUSES.has(workflowInstance.status)
            : false;
          const next = {
            ...existing,
            status: isTerminalWorkflow ? ("stopped" as const) : ("stopping" as const),
            stoppedAt: isTerminalWorkflow ? now : existing.stoppedAt,
            updatedAt: now,
          };
          uow.update("sandbox_instance", existing.id, (b) =>
            b.set({ status: next.status, stoppedAt: next.stoppedAt, updatedAt: now }).check(),
          );
          if (isTerminalWorkflow) {
            uow.triggerHook(
              "deliverLifecycleEvent",
              {
                id: `${input.workflowInstanceId}:stopped:stop-requested`,
                type: "stopped",
                sandboxId: String(existing.id),
                provider: CLOUDFLARE_SANDBOX_PROVIDER,
                status: "stopped",
                reason: "stop_requested",
              },
              { id: `${input.workflowInstanceId}:stopped:stop-requested` },
            );
          }
          return next;
        })
        .transform(({ mutateResult }) =>
          mutateResult ? sandboxInstanceSchema.parse(mutateResult) : null,
        )
        .build();
    },

    markSandboxInstanceStarting(args: SandboxInstanceMarkStartingInput) {
      const input = sandboxInstanceMarkStartingInputSchema.parse(args);
      return this.serviceTx(sandboxManagerFragmentSchema)
        .mutate(({ uow }) => {
          const now = uow.now();
          uow.update("sandbox_instance", input.id, (b) =>
            b.set({ status: "starting", updatedAt: now }),
          );
          // Billing starts with the attempt to start, as a booting container already runs.
          uow.create("sandbox_usage_meter", {
            id: input.workflowInstanceId,
            sandboxId: input.id,
            instanceType: input.instanceType,
            meteredThrough: now,
            leaseEndsAt: input.leaseMs === null ? null : now.plus(input.leaseMs),
            stoppedAt: null,
          });
          uow.triggerHook("meterSandboxUsage", {
            workflowInstanceId: input.workflowInstanceId,
            checkpointAt: null,
          });
        })
        .build();
    },

    markSandboxInstanceRunning(args: SandboxInstanceMarkRunningInput) {
      const input = sandboxInstanceMarkRunningInputSchema.parse(args);
      return this.serviceTx(sandboxManagerFragmentSchema)
        .mutate(({ uow }) => {
          const now = uow.now();
          const sleepAfter = input.sleepAfter ?? null;
          const expectedStopAt =
            input.keepAlive || sleepAfter === null
              ? null
              : now.plus(sleepAfterToMilliseconds(sleepAfter));
          uow.update("sandbox_instance", input.id, (b) =>
            b.set({
              status: "running",
              startedAt: now,
              expectedStopAt,
              lastError: null,
              updatedAt: now,
            }),
          );
          uow.triggerHook(
            "deliverLifecycleEvent",
            {
              id: `${input.workflowInstanceId}:ready`,
              type: "ready",
              sandboxId: input.id,
              provider: CLOUDFLARE_SANDBOX_PROVIDER,
              status: "running",
            },
            { id: `${input.workflowInstanceId}:ready` },
          );
        })
        .build();
    },

    markSandboxInstanceStopping(args: SandboxInstanceMarkStoppingInput) {
      const input = sandboxInstanceMarkStoppingInputSchema.parse(args);
      return this.serviceTx(sandboxManagerFragmentSchema)
        .mutate(({ uow }) => {
          const now = uow.now();
          uow.update("sandbox_instance", input.id, (b) =>
            b.set({ status: "stopping", updatedAt: now }),
          );
        })
        .build();
    },

    markSandboxInstanceStopped(args: SandboxInstanceMarkStoppedInput) {
      const input = sandboxInstanceMarkStoppedInputSchema.parse(args);
      return this.serviceTx(sandboxManagerFragmentSchema)
        .mutate(({ uow }) => {
          const now = uow.now();
          uow.update("sandbox_instance", input.id, (b) =>
            b.set({
              status: "stopped",
              stoppedAt: now,
              updatedAt: now,
            }),
          );
          stopSandboxUsageMeter(uow, input.workflowInstanceId);
          uow.triggerHook(
            "deliverLifecycleEvent",
            {
              id: `${input.workflowInstanceId}:stopped`,
              type: "stopped",
              sandboxId: input.id,
              provider: CLOUDFLARE_SANDBOX_PROVIDER,
              status: "stopped",
            },
            { id: `${input.workflowInstanceId}:stopped` },
          );
        })
        .build();
    },

    recordSandboxWorkspaceSnapshot(args: SandboxInstanceRecordWorkspaceSnapshotInput) {
      const input = sandboxInstanceRecordWorkspaceSnapshotInputSchema.parse(args);
      return this.serviceTx(sandboxManagerFragmentSchema)
        .mutate(({ uow }) => {
          uow.update("sandbox_instance", input.id, (b) =>
            b.set({ workspaceSnapshot: input.workspaceSnapshot, updatedAt: uow.now() }),
          );
        })
        .build();
    },

    renewSandboxWorkspaceSnapshot(args: SandboxInstanceRenewWorkspaceSnapshotInput) {
      const input = sandboxInstanceRenewWorkspaceSnapshotInputSchema.parse(args);
      const expiresAt = sandboxWorkspaceSnapshotExpiresAt(input.restoredAt);
      return this.serviceTx(sandboxManagerFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("sandbox_instance", (b) =>
            b
              .whereIndex("primary", (eb) => eb("id", "=", input.id))
              .select(["id", "workflowInstanceId", "workspaceSnapshot"]),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing] }) => {
          const snapshot = existing?.workspaceSnapshot ?? null;
          // A newer lifecycle or snapshot may have superseded this restoration attempt.
          if (
            !existing ||
            existing.workflowInstanceId !== input.workflowInstanceId ||
            snapshot === null ||
            snapshot.id !== input.snapshotId ||
            Date.parse(snapshot.expiresAt) >= Date.parse(expiresAt)
          ) {
            return;
          }
          uow.update("sandbox_instance", existing.id, (b) =>
            b.set({ workspaceSnapshot: { ...snapshot, expiresAt }, updatedAt: uow.now() }).check(),
          );
        })
        .build();
    },

    /**
     * Hands one run's usage to Billing up to its due checkpoint or its stop, never past its lease,
     * then schedules the next checkpoint until the run has ended.
     */
    meterSandboxUsage(payload: MeterSandboxUsagePayload) {
      return this.serviceTx(sandboxManagerFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("sandbox_usage_meter", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", payload.workflowInstanceId)),
          ),
        )
        .mutate(({ uow, retrieveResult: [meter] }) => {
          // Fully billed meters are deleted, which settles every delivery still queued for them.
          if (!meter) {
            return;
          }
          const checkpointAt = nextSandboxUsageCheckpoint(meter);
          // An earlier delivery already billed past the checkpoint this one was scheduled for.
          if (
            payload.checkpointAt !== null &&
            Date.parse(payload.checkpointAt) !== checkpointAt.getTime()
          ) {
            return;
          }
          const endsAt = sandboxUsageEndsAt(meter);
          // Only instants that have passed are billed: a stop, or a checkpoint whose delivery is due.
          // A lease may still lie ahead.
          const target =
            payload.checkpointAt === null
              ? (meter.stoppedAt ?? meter.meteredThrough)
              : checkpointAt;
          const through = endsAt !== null && endsAt < target ? endsAt : target;

          for (const usage of sandboxUsageByMonth(payload.workflowInstanceId, meter, through)) {
            uow.triggerHook("recordSandboxUsage", usage, { id: usage.id });
          }
          if (endsAt !== null && through >= endsAt) {
            uow.delete("sandbox_usage_meter", meter.id, (b) => b.check());
            return;
          }
          if (through > meter.meteredThrough) {
            uow.update("sandbox_usage_meter", meter.id, (b) =>
              b.set({ meteredThrough: through }).check(),
            );
          }
          const nextCheckpointAt = nextSandboxUsageCheckpoint({
            ...meter,
            meteredThrough: through,
          });
          uow.triggerHook(
            "meterSandboxUsage",
            {
              workflowInstanceId: payload.workflowInstanceId,
              checkpointAt: nextCheckpointAt.toISOString(),
            },
            { processAt: nextCheckpointAt },
          );
        })
        .build();
    },

    markSandboxInstanceError(args: SandboxInstanceMarkErrorInput) {
      const input = sandboxInstanceMarkErrorInputSchema.parse(args);
      return this.serviceTx(sandboxManagerFragmentSchema)
        .mutate(({ uow }) => {
          const now = uow.now();
          uow.update("sandbox_instance", input.id, (b) =>
            b.set({
              status: "error",
              lastError: input.lastError,
              updatedAt: now,
            }),
          );
        })
        .build();
    },
  });
}

/** Ends a run's billing now; its meter then bills the remainder. */
export function stopSandboxUsageMeter(uow: SandboxManagerUnitOfWork, workflowInstanceId: string) {
  uow.update("sandbox_usage_meter", workflowInstanceId, (b) => b.set({ stoppedAt: uow.now() }));
  uow.triggerHook("meterSandboxUsage", { workflowInstanceId, checkpointAt: null });
}

type SandboxUsageMeter = {
  meteredThrough: Date;
  leaseEndsAt: Date | null;
  stoppedAt: Date | null;
};

/** The container cannot outlive its lease, even when its manager stops it later. */
function sandboxUsageEndsAt({ leaseEndsAt, stoppedAt }: SandboxUsageMeter): Date | null {
  if (leaseEndsAt === null || stoppedAt === null) {
    return leaseEndsAt ?? stoppedAt;
  }
  return stoppedAt < leaseEndsAt ? stoppedAt : leaseEndsAt;
}

function nextSandboxUsageCheckpoint(meter: SandboxUsageMeter): Date {
  const checkpointAt = new Date(
    meter.meteredThrough.getTime() + SANDBOX_USAGE_CHECKPOINT_INTERVAL_MS,
  );
  const endsAt = sandboxUsageEndsAt(meter);
  return endsAt !== null && endsAt < checkpointAt ? endsAt : checkpointAt;
}

/** Splits unbilled usage at UTC month starts, since Billing attributes each event to one month. */
function sandboxUsageByMonth(
  workflowInstanceId: string,
  meter: SandboxUsageMeter & { sandboxId: string; instanceType: SandboxInstanceType },
  through: Date,
): SandboxUsage[] {
  const usage: SandboxUsage[] = [];
  let from = meter.meteredThrough;
  while (from < through) {
    const monthEnd = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
    const until = monthEnd < through ? monthEnd : through;
    usage.push({
      id: `sandbox-usage:${workflowInstanceId}:${from.getTime()}`,
      sandboxId: meter.sandboxId,
      workflowInstanceId,
      instanceType: meter.instanceType,
      from: from.toISOString(),
      through: until.toISOString(),
      seconds: Math.ceil((until.getTime() - from.getTime()) / 1000),
    });
    from = until;
  }
  return usage;
}

/**
 * Resumes the saved workspace while its snapshot lasts. A snapshot only restores onto the image it
 * was taken from, so a saved workspace cannot change images.
 */
function resolveSandboxWorkspace(
  sandboxId: string,
  existing: { image: SandboxImage; workspaceSnapshot: SandboxWorkspaceSnapshot | null } | null,
  requestedImage: SandboxImage | undefined,
  now: number,
): { image: SandboxImage; source: SandboxStartSource; snapshot: SandboxWorkspaceSnapshot | null } {
  const snapshot = existing?.workspaceSnapshot ?? null;
  if (existing && isSandboxWorkspaceSnapshotResumable(snapshot, now)) {
    if (requestedImage !== undefined && requestedImage !== existing.image) {
      throw new Error(
        `Sandbox "${sandboxId}" has a saved workspace on the "${existing.image}" image. Start it without an image, or start a new sandbox for the "${requestedImage}" image.`,
      );
    }
    return {
      image: existing.image,
      source: { kind: "snapshot", snapshotId: snapshot.id },
      snapshot,
    };
  }
  const image = requestedImage ?? DEFAULT_SANDBOX_IMAGE;
  return { image, source: { kind: "image", image }, snapshot: null };
}
