import {
  createDurableHooksProcessor,
  type DurableHooksDispatcherDurableObjectHandler,
} from "@fragno-dev/db/dispatchers/cloudflare-do";

import { defaultFragnoRuntime } from "@fragno-dev/core";
import { createWorkflowsFragment } from "@fragno-dev/workflows";

import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";
import { createAutomationFragment, type AutomationFragmentConfig } from "@/fragno/automation";
import {
  defineAutomationCodemodeWorkflow,
  definePiCodemodeWorkflow,
} from "@/fragno/automation/engine/workflow";

export type AutomationsRuntime = {
  workflowsFragment: ReturnType<typeof createWorkflowsFragment>;
  automationFragment: ReturnType<typeof createAutomationFragment>;
  dispatcher: DurableHooksDispatcherDurableObjectHandler | null;
};

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

export const createAutomationsRuntime = (
  runtime: BackofficeFragmentRuntimeOptions,
  config: Pick<
    AutomationFragmentConfig,
    | "env"
    | "runtime"
    | "createPiAutomationContext"
    | "automationFileSystem"
    | "getAutomationFileSystem"
    | "ownerScope"
  >,
) => {
  const databaseAdapter = runtime.adapters.createAdapter({
    kind: "automations",
  });
  const workflowsFragment = createWorkflowsFragment(
    {
      workflows: {
        AUTOMATION_CODEMODE_SCRIPT: defineAutomationCodemodeWorkflow(config),
        PI_CODEMODE_SCRIPT: definePiCodemodeWorkflow(config),
      },
      runtime: config.runtime?.fragnoRuntime ?? defaultFragnoRuntime,
    },
    {
      databaseAdapter,
      mountRoute: "/api/automations-workflows",
      outbox: { enabled: true },
    },
  );
  const automationFragment = createAutomationFragment(
    {
      env: config.env,
      runtime: config.runtime,
      createPiAutomationContext: config.createPiAutomationContext,
      automationFileSystem: config.automationFileSystem,
      getAutomationFileSystem: config.getAutomationFileSystem,
      ownerScope: config.ownerScope,
    },
    {
      databaseAdapter,
      mountRoute: "/api/automations",
      outbox: { enabled: true },
    },
    {
      workflows: workflowsFragment.services,
    },
  );

  return {
    workflowsFragment,
    automationFragment,
    dispatcher: null,
  } satisfies AutomationsRuntime;
};

export const createAutomationsDispatcher = (
  workflowsFragment: ReturnType<typeof createWorkflowsFragment>,
  automationFragment: ReturnType<typeof createAutomationFragment>,
  state: DurableObjectState,
  env: CloudflareEnv,
): DurableHooksDispatcherDurableObjectHandler => {
  const dispatcherFactory = createDurableHooksProcessor([workflowsFragment, automationFragment], {
    onProcessError: (error) => {
      console.error("Automations durable hook processor error", error);
    },
  });

  return dispatcherFactory(state, env);
};

export const buildNotConfiguredResponse = () =>
  jsonResponse(
    {
      message: "Automations runtime is not ready.",
      code: "NOT_CONFIGURED",
    },
    400,
  );
