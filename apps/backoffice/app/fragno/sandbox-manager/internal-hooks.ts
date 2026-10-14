import type { SandboxLifecycleEvent, SandboxLifecycleWorkflowParams } from "./contracts";

export type EnqueueSandboxLifecycleWorkflowPayload = {
  workflowInstanceId: string;
  params: SandboxLifecycleWorkflowParams;
};

export type SandboxManagerInternalHooks = {
  enqueueSandboxLifecycleWorkflow: (
    payload: EnqueueSandboxLifecycleWorkflowPayload,
  ) => Promise<void> | void;
  deliverLifecycleEvent: (event: SandboxLifecycleEvent) => Promise<void> | void;
};
