import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import {
  createDurableHooksProcessor,
  type DurableHooksDispatcherDurableObjectHandler,
} from "@fragno-dev/db/dispatchers/cloudflare-do";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";

import { defaultFragnoRuntime } from "@fragno-dev/core";
import { createWorkflowsFragment } from "@fragno-dev/workflows";

import { createAutomationFragment, type AutomationFragmentConfig } from "@/fragno/automation";

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

const createAutomationsAdapter = (state: DurableObjectState) =>
  new SqlAdapter({
    dialect: new DurableObjectDialect({ ctx: state }),
    driverConfig: new CloudflareDurableObjectsDriverConfig(),
  });

export const createAutomationsRuntime = (
  state: DurableObjectState,
  config: Pick<
    AutomationFragmentConfig,
    "env" | "sourceAdapters" | "createPiAutomationContext" | "builtinScripts" | "builtinBindings"
  > = {},
) => {
  const databaseAdapter = createAutomationsAdapter(state);
  const workflowsFragment = createWorkflowsFragment(
    {
      workflows: {},
      runtime: defaultFragnoRuntime,
    },
    {
      databaseAdapter,
      mountRoute: "/api/automations",
    },
  );
  const automationFragment = createAutomationFragment(
    {
      env: config.env,
      sourceAdapters: config.sourceAdapters,
      createPiAutomationContext: config.createPiAutomationContext,
      builtinScripts: config.builtinScripts,
      builtinBindings: config.builtinBindings,
    },
    {
      databaseAdapter,
      mountRoute: "/api/automations/bindings",
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
): DurableHooksDispatcherDurableObjectHandler | null => {
  try {
    const dispatcherFactory = createDurableHooksProcessor([workflowsFragment, automationFragment], {
      onProcessError: (error) => {
        console.error("Automations durable hook processor error", error);
      },
    });
    return dispatcherFactory(state, env);
  } catch (error) {
    console.warn("Automations durable hook processor disabled", error);
    return null;
  }
};

export const buildNotConfiguredResponse = () =>
  jsonResponse(
    {
      message: "Automations runtime is not ready.",
      code: "NOT_CONFIGURED",
    },
    400,
  );
