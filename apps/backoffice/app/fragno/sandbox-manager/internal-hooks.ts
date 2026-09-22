import type { SandboxInstanceRequestInput, SandboxLifecycleEvent } from "./contracts";

export type EnqueueSandboxLifecycleWorkflowPayload = {
  workflowInstanceId: string;
  params: SandboxInstanceRequestInput;
};

export type SandboxManagerInternalHooks = {
  enqueueSandboxLifecycleWorkflow: (
    payload: EnqueueSandboxLifecycleWorkflowPayload,
  ) => Promise<void> | void;
  deliverLifecycleEvent: (event: SandboxLifecycleEvent) => Promise<void> | void;
};
