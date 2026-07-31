import {
  createDurableHooksProcessor,
  type DurableHooksDispatcherDurableObjectHandler,
} from "@fragno-dev/db/dispatchers/cloudflare-do";

import { defaultFragnoRuntime } from "@fragno-dev/core";
import { createWorkflowsFragment } from "@fragno-dev/workflows";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";
import {
  BackofficeForbiddenError,
  BackofficeKernel,
  type BackofficeAuthorizationDenialReason,
} from "@/backoffice-runtime/kernel";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
import { createAutomationFragment, type AutomationFragmentConfig } from "@/fragno/automation";
import {
  defineAutomationCodemodeWorkflow,
  definePiCodemodeWorkflow,
} from "@/fragno/automation/engine/workflow";

import { defineMarketplaceIngestWorkflow } from "./marketplace-ingest-workflow";
import { defineMarketplacePublishWorkflow } from "./marketplace-publish-workflow";
import { defineSandboxLifecycleWorkflow } from "./sandbox-lifecycle-workflow";
import { SANDBOX_LIFECYCLE_WORKFLOW_NAME } from "./sandboxes-storage-runtime";

type AutomationFragmentWithExecutionContext = ReturnType<
  typeof createAutomationFragment<BackofficeExecutionContext>
>;

const AUTOMATIONS_AUTHORIZATION_STATUS_BY_REASON = {
  "authority-unavailable": 503,
  "principal-permission-denied": 403,
  "actor-capability-denied": 403,
  "context-access-denied": 403,
  "policy-denied": 403,
} as const satisfies Record<BackofficeAuthorizationDenialReason, 403 | 503>;

export type AutomationsRuntime = {
  workflowsFragment: ReturnType<typeof createWorkflowsFragment>;
  automationFragment: AutomationFragmentWithExecutionContext;
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
    | "sandboxProviders"
  > & { kernel: BackofficeKernel },
) => {
  const databaseAdapter = runtime.adapters.createAdapter({
    kind: "automations",
  });
  let automationFragment: AutomationFragmentWithExecutionContext | undefined;
  const workflowsFragment = createWorkflowsFragment(
    {
      workflows: {
        AUTOMATION_CODEMODE_SCRIPT: defineAutomationCodemodeWorkflow(config),
        PI_CODEMODE_SCRIPT: definePiCodemodeWorkflow(config),
        MARKETPLACE_PUBLISH: defineMarketplacePublishWorkflow({
          ownerScope: config.ownerScope,
          runtime: config.runtime,
        }),
        MARKETPLACE_INGEST: defineMarketplaceIngestWorkflow({
          ownerScope: config.ownerScope,
          runtime: config.runtime,
          getAutomationFragment: () => automationFragment,
        }),
        SANDBOX_LIFECYCLE: defineSandboxLifecycleWorkflow({
          ownerScope: config.ownerScope,
          sandboxProviders: config.sandboxProviders,
          getAutomationFragment: () => automationFragment,
        }),
      },
      runtime: config.runtime?.fragnoRuntime ?? defaultFragnoRuntime,
      onWorkflowTerminal: async (payload) => {
        if (payload.workflowName !== SANDBOX_LIFECYCLE_WORKFLOW_NAME) {
          return;
        }
        if (!automationFragment) {
          throw new Error("Sandbox lifecycle terminal hook requires the automations fragment.");
        }

        const fragment = automationFragment;
        await fragment.callServices(() =>
          fragment.services.stopSandboxInstanceForTerminalWorkflow({
            workflowInstanceId: payload.instanceId,
          }),
        );
      },
    },
    {
      databaseAdapter,
      mountRoute: "/api/automations-workflows",
      outbox: { enabled: true },
    },
  );
  automationFragment = createAutomationFragment<BackofficeExecutionContext>(
    {
      env: config.env,
      runtime: config.runtime,
      createPiAutomationContext: config.createPiAutomationContext,
      automationFileSystem: config.automationFileSystem,
      getAutomationFileSystem: config.getAutomationFileSystem,
      ownerScope: config.ownerScope,
      sandboxProviders: config.sandboxProviders,
    },
    {
      databaseAdapter,
      mountRoute: "/api/automations",
      outbox: { enabled: true },
    },
    {
      workflows: workflowsFragment.services,
    },
  ).withMiddleware(async function authorizeAutomationStoreMutations(
    { ifMatchesRoute, requestContext },
    { error },
  ) {
    const authorizeStoreMutation = async (readInput: () => Promise<{ key: string }>) => {
      if (!requestContext) {
        return error(
          {
            message: "Automations store mutation requires trusted action context.",
            code: "AUTOMATIONS_ACTION_CONTEXT_REQUIRED",
          },
          403,
        );
      }

      const { key } = await readInput();
      try {
        await config.kernel.assertAuthorized({
          execution: requestContext,
          operation: BACKOFFICE_PERMISSION.store.modify,
          resource: { kind: "automation-store-entry", key },
        });
        return undefined;
      } catch (cause) {
        if (cause instanceof BackofficeForbiddenError) {
          return error(
            {
              message: cause.message,
              code: cause.reason,
            },
            AUTOMATIONS_AUTHORIZATION_STATUS_BY_REASON[cause.reason],
          );
        }
        throw cause;
      }
    };

    const setResponse = await ifMatchesRoute("POST", "/store/set", async ({ input }) =>
      authorizeStoreMutation(input.valid),
    );
    if (setResponse) {
      return setResponse;
    }

    return await ifMatchesRoute("POST", "/store/delete", async ({ input }) =>
      authorizeStoreMutation(input.valid),
    );
  });

  return {
    workflowsFragment,
    automationFragment,
    dispatcher: null,
  } satisfies AutomationsRuntime;
};

export const createAutomationsDispatcher = (
  workflowsFragment: ReturnType<typeof createWorkflowsFragment>,
  automationFragment: AutomationFragmentWithExecutionContext,
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
