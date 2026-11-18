import type {
  WorkflowDuration,
  WorkflowStep,
  WorkflowStepConfig,
  WorkflowStepConsumeTx,
  WorkflowStepHookOperation,
  WorkflowStepTx,
} from "./workflow";
import type { WorkflowStepCallOutcome } from "./workflow-tick";

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

export type RemoteWorkflowWaitForEventOptions<T = unknown> = {
  type: string;
  timeout?: WorkflowDuration;
  onConsume?: (
    tx: WorkflowStepConsumeTx,
    event: { type: string; payload: Readonly<T>; timestamp: Date },
  ) => Promise<void> | void;
};

/**
 * Host-side control surface for running workflow code in another realm, such as a sandboxed
 * isolate. The host owns durable runner state; the remote realm runs the workflow code under its
 * own `createWorkflowTick`, which hands step outcomes back to the code and decides when the tick
 * ends. Each step call returns its outcome without waiting for its turn: a step that waits parks,
 * and a settled step carries its place in the settle order. A `step.do` callback cannot call steps.
 */
export interface RemoteWorkflowStepHost {
  /** Settle orders of the steps that settled in earlier ticks, for the remote tick to replay. */
  readonly settledOrders: readonly number[];
  do<T>(
    name: string,
    config: WorkflowStepConfig | undefined,
    callback: (tx: WorkflowStepTx) => Promise<T> | T,
  ): Promise<WorkflowStepCallOutcome<T>>;
  sleep(name: string, duration: WorkflowDuration): Promise<WorkflowStepCallOutcome<void>>;
  sleepUntil(name: string, timestamp: Date | number): Promise<WorkflowStepCallOutcome<void>>;
  waitForEvent<T = unknown>(
    name: string,
    options: RemoteWorkflowWaitForEventOptions<T>,
  ): Promise<WorkflowStepCallOutcome<{ type: string; payload: Readonly<T>; timestamp: Date }>>;
  /**
   * Reports that the remote tick ended idle: the workflow code stopped without settling, with no
   * step call in flight. The runner ends the tick waiting on the steps that parked, or errors the
   * instance as stalled when none did. Throws, so the remote workflow ends with it.
   */
  reportIdle(): never;
  /**
   * Reports that this tick could not run where the host sent it, such as to an unreachable
   * executor. The runner keeps step progress and runs the whole tick again later with growing
   * delays, then errors the instance once consecutive interrupted ticks exhaust their budget. Steps
   * the interrupted tick had started may run again. Only workflows defined as remote can interrupt
   * their tick, and catching the thrown error does not undo the report.
   */
  interruptTick(cause: string): never;
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
