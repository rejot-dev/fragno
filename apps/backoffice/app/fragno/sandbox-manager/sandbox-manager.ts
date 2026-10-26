import { defaultFragnoRuntime } from "@fragno-dev/core";
import { createWorkflowsFragment } from "@fragno-dev/workflows";

import {
  reportFinishedWorkflows,
  type BackofficeHostTelemetry,
} from "@/backoffice-runtime/backoffice-telemetry";
import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";

import type { SandboxManagerFragmentConfig } from "./definition";
import { defineSandboxLifecycleWorkflow } from "./lifecycle-workflow";
import { createSandboxManagerFragment } from "./sandbox-manager-fragment";
import { SANDBOX_LIFECYCLE_WORKFLOW_NAME } from "./services";

export function createSandboxManagerRuntime(
  runtime: BackofficeFragmentRuntimeOptions,
  config: SandboxManagerFragmentConfig,
  telemetry: BackofficeHostTelemetry,
) {
  const databaseAdapter = runtime.adapters.createAdapter({ kind: "sandbox-manager" });
  let sandboxManagerFragment: ReturnType<typeof createSandboxManagerFragment> | undefined;

  const workflowsFragment = createWorkflowsFragment(
    {
      workflows: {
        SANDBOX_LIFECYCLE: defineSandboxLifecycleWorkflow({
          sandboxProviders: config.sandboxProviders,
          getSandboxManagerFragment: () => sandboxManagerFragment,
        }),
      },
      runtime: defaultFragnoRuntime,
      onWorkflowTerminal: reportFinishedWorkflows(
        telemetry,
        // Sandbox lifecycle workflows run no script of their own.
        () => null,
        async function reconcileTerminalSandboxLifecycle(payload) {
          if (payload.workflowName !== SANDBOX_LIFECYCLE_WORKFLOW_NAME || !sandboxManagerFragment) {
            return;
          }
          const fragment = sandboxManagerFragment;
          await fragment.callServices(() =>
            fragment.services.stopSandboxInstanceForTerminalWorkflow({
              workflowInstanceId: payload.instanceId,
            }),
          );
        },
      ),
    },
    {
      databaseAdapter,
      transactionInstrumentation: runtime.transactionInstrumentation,
      mountRoute: "/api/sandbox-manager/workflows",
      outbox: { enabled: true },
    },
  );

  sandboxManagerFragment = createSandboxManagerFragment(
    config,
    {
      databaseAdapter,
      transactionInstrumentation: runtime.transactionInstrumentation,
      mountRoute: "/api/sandbox-manager",
      outbox: { enabled: true },
    },
    { workflows: workflowsFragment.services },
  );

  return {
    sandboxManagerFragment,
    workflowsFragment,
  };
}
