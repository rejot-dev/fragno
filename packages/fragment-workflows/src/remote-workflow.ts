import type { WorkflowStepIdentity } from "./step-identity";
import type {
  WorkflowDuration,
  WorkflowStep,
  WorkflowStepConfig,
  WorkflowStepConsumeTx,
  WorkflowStepHookOperation,
  WorkflowStepTx,
} from "./workflow";

export type { WorkflowStepIdentity } from "./step-identity";
export type { WorkflowStepWorkflowOperation } from "./workflow";

/** Hook intent sent over RPC; the target names a mount in the trusted host's scope. */
export type RemoteWorkflowHookIntent = Omit<WorkflowStepHookOperation, "namespace"> & {
  target: string;
  schemaName: string;
};

/** A host-owned hook grant bound to one mounted fragment's actual namespace. */
export type RemoteWorkflowAllowedHook = {
  target: string;
  schemaName: string;
  hookName: string;
  namespace: string;
};

/** Resolve a remote hook against the host's scoped mounts before queuing the step mutation. */
export function resolveRemoteWorkflowHookIntent(
  operation: RemoteWorkflowHookIntent,
  allowedHooks: readonly RemoteWorkflowAllowedHook[],
): WorkflowStepHookOperation {
  const matchingTargets = allowedHooks.filter(
    (hook) =>
      hook.target === operation?.target &&
      hook.schemaName === operation?.schemaName &&
      hook.hookName === operation?.hookName,
  );
  const target = matchingTargets[0];
  if (!target) {
    throw new Error(
      `REMOTE_WORKFLOW_HOOK_NOT_ALLOWED: ${operation?.target}/${operation?.schemaName}/${operation?.hookName}`,
    );
  }
  if (matchingTargets.length > 1) {
    throw new Error(
      `REMOTE_WORKFLOW_HOOK_TARGET_AMBIGUOUS: ${operation.target}/${operation.schemaName}/${operation.hookName}`,
    );
  }
  return {
    namespace: target.namespace,
    hookName: operation.hookName,
    payload: operation.payload,
    when: operation.when,
  };
}

export type RemoteWorkflowStepScope = WorkflowStepIdentity | null;

export type RemoteWorkflowStepSuspendReason =
  | { type: "sleep"; stepKey: string; delayMs?: number | null; runAt?: Date }
  | {
      type: "waitForEvent";
      stepKey: string;
      eventType: string;
      delayMs?: number | null;
      runAt?: Date;
    }
  | { type: "retry"; stepKey: string; delayMs?: number | null }
  | { type: "checkpoint"; stepKey: string; delayMs: 0 };

export type RemoteWorkflowSuspension = {
  __fragnoRemoteWorkflowSuspended: true;
  reason: RemoteWorkflowStepSuspendReason;
};

export class RemoteWorkflowSuspendedError extends Error {
  readonly reason: RemoteWorkflowStepSuspendReason;

  constructor(reason: RemoteWorkflowStepSuspendReason) {
    super("WORKFLOW_STEP_SUSPENDED");
    this.name = "RemoteWorkflowSuspendedError";
    this.reason = reason;
  }
}

export const createRemoteWorkflowSuspension = (
  reason: RemoteWorkflowStepSuspendReason,
): RemoteWorkflowSuspension => ({
  __fragnoRemoteWorkflowSuspended: true,
  reason,
});

export const isRemoteWorkflowSuspension = (value: unknown): value is RemoteWorkflowSuspension => {
  if (!value || typeof value !== "object") {
    return false;
  }
  return (
    "__fragnoRemoteWorkflowSuspended" in value &&
    (value as { __fragnoRemoteWorkflowSuspended?: unknown }).__fragnoRemoteWorkflowSuspended ===
      true &&
    "reason" in value
  );
};

export type RemoteWorkflowStepDoCallback<T> = (
  tx: WorkflowStepTx,
  scope: WorkflowStepIdentity,
) => Promise<T> | T;

export type RemoteWorkflowWaitForEventOptions<T = unknown> = {
  type: string;
  timeout?: WorkflowDuration;
  onConsume?: (
    tx: WorkflowStepConsumeTx,
    event: { type: string; payload: Readonly<T>; timestamp: Date },
  ) => Promise<void> | void;
};

/**
 * Host-side control surface for running workflow code in another JS realm/process.
 *
 * Implementations own durable runner state; remote clients pass the current parent scope explicitly
 * when invoking step helpers so nested step identities remain deterministic across RPC boundaries.
 */
export interface RemoteWorkflowStepHost {
  do<T>(
    parentScope: RemoteWorkflowStepScope,
    name: string,
    config: WorkflowStepConfig | undefined,
    callback: RemoteWorkflowStepDoCallback<T>,
  ): Promise<T>;
  sleep(
    parentScope: RemoteWorkflowStepScope,
    name: string,
    duration: WorkflowDuration,
  ): Promise<void | RemoteWorkflowSuspension>;
  sleepUntil(
    parentScope: RemoteWorkflowStepScope,
    name: string,
    timestamp: Date | number,
  ): Promise<void | RemoteWorkflowSuspension>;
  waitForEvent<T = unknown>(
    parentScope: RemoteWorkflowStepScope,
    name: string,
    options: RemoteWorkflowWaitForEventOptions<T>,
  ): Promise<{ type: string; payload: Readonly<T>; timestamp: Date }>;
}

export type RemoteCapableWorkflowStep = WorkflowStep & {
  remote: RemoteWorkflowStepHost;
};

export function getRemoteWorkflowStepHost(step: WorkflowStep): RemoteWorkflowStepHost {
  const host = (step as Partial<RemoteCapableWorkflowStep>).remote;
  if (!host) {
    throw new Error("WORKFLOW_STEP_REMOTE_HOST_UNAVAILABLE");
  }
  return host;
}
