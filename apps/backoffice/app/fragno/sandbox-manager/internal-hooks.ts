import type { HookFn } from "@fragno-dev/db";

import type { SandboxLifecycleEvent, SandboxLifecycleWorkflowParams } from "./contracts";

export type EnqueueSandboxLifecycleWorkflowPayload = {
  workflowInstanceId: string;
  params: SandboxLifecycleWorkflowParams;
};

export type SandboxManagerInternalHooks = {
  enqueueSandboxLifecycleWorkflow: HookFn<EnqueueSandboxLifecycleWorkflowPayload>;
  deliverLifecycleEvent: HookFn<SandboxLifecycleEvent>;
};
