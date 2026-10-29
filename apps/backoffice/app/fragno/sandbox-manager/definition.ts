import { defineFragment } from "@fragno-dev/core";
import { withDatabase, type HookContext } from "@fragno-dev/db";
import type { WorkflowsFragmentServices } from "@fragno-dev/workflows";

import type { SandboxRuntimeProvider } from "@/sandbox/contracts";

import type { SandboxLifecycleEvent, SandboxUsage } from "./contracts";
import type {
  EnqueueSandboxLifecycleWorkflowPayload,
  MeterSandboxUsagePayload,
  SandboxManagerInternalHooks,
} from "./internal-hooks";
import { sandboxManagerFragmentSchema } from "./schema";
import { createSandboxManagerServices, SANDBOX_LIFECYCLE_WORKFLOW_NAME } from "./services";

export type SandboxManagerWorkflowsService = Pick<
  WorkflowsFragmentServices,
  "createInstance" | "getInstanceStatus" | "sendEvent"
>;

export type SandboxManagerFragmentConfig = {
  sandboxProviders: Record<string, SandboxRuntimeProvider>;
  deliverLifecycleEvent: (event: SandboxLifecycleEvent) => Promise<void>;
  /** Must accept redelivery of the same usage ID, which follows a lost acknowledgement. */
  recordUsage: (usage: SandboxUsage, hook: HookContext) => Promise<void>;
};

export const sandboxManagerFragmentDefinition = defineFragment<SandboxManagerFragmentConfig>(
  "sandbox-manager",
)
  .extend(withDatabase(sandboxManagerFragmentSchema))
  .usesService<"workflows", SandboxManagerWorkflowsService>("workflows")
  .providesBaseService(({ defineService, config, serviceDeps }) =>
    createSandboxManagerServices(defineService, {
      workflows: serviceDeps.workflows,
      sandboxProviders: config.sandboxProviders,
    }),
  )
  .provideHooks(
    ({ defineHook, config, services, serviceDeps }) =>
      ({
        enqueueSandboxLifecycleWorkflow: defineHook(
          async function enqueueRequestedSandboxLifecycleWorkflow(
            payload: EnqueueSandboxLifecycleWorkflowPayload,
          ) {
            await this.handlerTx()
              .withServiceCalls(
                () =>
                  [
                    serviceDeps.workflows.createInstance(SANDBOX_LIFECYCLE_WORKFLOW_NAME, {
                      id: payload.workflowInstanceId,
                      params: payload.params,
                    }),
                  ] as const,
              )
              .execute();
          },
        ),
        deliverLifecycleEvent: defineHook(async function deliverSandboxLifecycleEvent(
          event: SandboxLifecycleEvent,
        ) {
          await config.deliverLifecycleEvent(event);
        }),
        meterSandboxUsage: defineHook(async function meterSandboxUsage(
          payload: MeterSandboxUsagePayload,
        ) {
          await this.handlerTx()
            .withServiceCalls(() => [services.meterSandboxUsage(payload)] as const)
            .execute();
        }),
        recordSandboxUsage: defineHook(async function recordSandboxUsage(usage: SandboxUsage) {
          await config.recordUsage(usage, this);
        }),
      }) satisfies SandboxManagerInternalHooks,
  )
  .build();
