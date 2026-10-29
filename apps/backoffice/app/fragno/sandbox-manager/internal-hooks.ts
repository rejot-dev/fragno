import type { HookFn } from "@fragno-dev/db";

import type {
  SandboxLifecycleEvent,
  SandboxLifecycleWorkflowParams,
  SandboxUsage,
} from "./contracts";

export type EnqueueSandboxLifecycleWorkflowPayload = {
  workflowInstanceId: string;
  params: SandboxLifecycleWorkflowParams;
};

export type MeterSandboxUsagePayload = {
  workflowInstanceId: string;
  /**
   * The checkpoint this delivery was scheduled for. Null when the run starts or stops, which bills
   * through its end once it has one.
   */
  checkpointAt: string | null;
};

export type SandboxManagerInternalHooks = {
  enqueueSandboxLifecycleWorkflow: HookFn<EnqueueSandboxLifecycleWorkflowPayload>;
  deliverLifecycleEvent: HookFn<SandboxLifecycleEvent>;
  meterSandboxUsage: HookFn<MeterSandboxUsagePayload>;
  recordSandboxUsage: HookFn<SandboxUsage>;
};
