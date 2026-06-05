import type { WorkflowStepIdentity } from "./step-identity";
import type {
  WorkflowDuration,
  WorkflowStep,
  WorkflowStepConfig,
  WorkflowStepConsumeTx,
  WorkflowStepTx,
} from "./workflow";

export type { WorkflowStepIdentity } from "./step-identity";

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
  | { type: "retry"; stepKey: string; delayMs?: number | null };

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
