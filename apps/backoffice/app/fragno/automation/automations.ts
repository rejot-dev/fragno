import {
  createDurableHooksProcessor,
  type DurableHooksDispatcherDurableObjectHandler,
} from "@fragno-dev/db/dispatchers/cloudflare-do";
import type { DurableHooksInstrumentation } from "@fragno-dev/db/hooks";

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
import { BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY } from "@/fragno/automation/actors";
import {
  defineAutomationCodemodeWorkflow,
  definePiCodemodeWorkflow,
} from "@/fragno/automation/engine/workflow";
import {
  createPiRuntimeDefinition,
  type CreatePiRuntimeDefinitionOptions,
  type PiFragment,
  type PiRuntimeToolContext,
} from "@/fragno/pi/pi";
import { BACKOFFICE_PI_WORKFLOW_NAME } from "@/fragno/pi/pi-shared";
import {
  createPiFragmentRuntime,
  type PiRuntime,
} from "@/fragno/runtime-tools/families/pi-runtime";

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
  workflowsFragment: ReturnType<typeof createWorkflowsFragment<BackofficeExecutionContext>>;
  automationFragment: AutomationFragmentWithExecutionContext;
  piFragment: PiFragment;
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
    | "automationFileSystem"
    | "getAutomationFileSystem"
    | "ownerScope"
    | "sandboxProviders"
  > & {
    kernel: BackofficeKernel;
    pi: Omit<CreatePiRuntimeDefinitionOptions, "scope" | "kernel" | "runtimeToolContext"> & {
      createRuntime?(execution: BackofficeExecutionContext, fragment: PiFragment): PiRuntime;
      createRuntimeToolContext(
        execution: BackofficeExecutionContext,
        pi: PiRuntime,
      ): PiRuntimeToolContext;
    };
  },
): AutomationsRuntime => {
  const databaseAdapter = runtime.adapters.createAdapter({
    kind: "automations",
  });
  let automationFragment: AutomationFragmentWithExecutionContext | undefined;
  let piFragment: PiFragment | undefined;
  const createHostedPiRuntime = (execution: BackofficeExecutionContext): PiRuntime => {
    if (!piFragment) {
      throw new Error("Pi fragment is not ready.");
    }
    return config.pi.createRuntime
      ? config.pi.createRuntime(execution, piFragment)
      : createPiFragmentRuntime({ fragment: piFragment, execution });
  };
  const pi = createPiRuntimeDefinition({
    ...config.pi,
    scope: config.ownerScope,
    kernel: config.kernel,
    runtimeToolContext: (execution) => {
      return config.pi.createRuntimeToolContext(execution, createHostedPiRuntime(execution));
    },
  });
  const workflowsFragment = createWorkflowsFragment<BackofficeExecutionContext>(
    {
      workflows: {
        AUTOMATION_CODEMODE_SCRIPT: defineAutomationCodemodeWorkflow({
          ...config,
          createPiAutomationContext: ({ event }) => ({
            runtime: createHostedPiRuntime({
              scope: event.scope,
              actors: event.actors,
            }),
          }),
        }),
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
        ...pi.workflows,
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
      transactionInstrumentation: runtime.transactionInstrumentation,
      mountRoute: "/api/workflows",
      outbox: { enabled: true },
    },
  ).withMiddleware(async function authorizeBackofficeWorkflowRoutes(
    { ifMatchesRoute, requestContext, requestState },
    { error },
  ) {
    if (!requestContext) {
      return error(
        {
          message: "Workflow routes require trusted action context.",
          code: "context-access-denied",
        },
        403,
      );
    }

    const authorize = async (
      operation:
        | typeof BACKOFFICE_PERMISSION.workflow.read
        | typeof BACKOFFICE_PERMISSION.workflow.modify,
      resource: Record<string, unknown>,
    ) => {
      try {
        await config.kernel.assertAuthorized({
          execution: requestContext,
          operation,
          resource,
        });
        return undefined;
      } catch (cause) {
        if (cause instanceof BackofficeForbiddenError) {
          return error(
            { message: cause.message, code: cause.reason },
            AUTOMATIONS_AUTHORIZATION_STATUS_BY_REASON[cause.reason],
          );
        }
        throw cause;
      }
    };

    const createResponse = await ifMatchesRoute(
      "POST",
      "/:workflowName/instances",
      async ({ input, pathParams }) => {
        if (pathParams.workflowName === BACKOFFICE_PI_WORKFLOW_NAME) {
          return error(
            {
              message: "Interactive Pi sessions must be created through the Pi API.",
              code: "WORKFLOW_NOT_FOUND",
            },
            404,
          );
        }
        const authorization = await authorize(BACKOFFICE_PERMISSION.workflow.modify, {
          kind: "workflow",
          workflowName: pathParams.workflowName,
        });
        if (authorization) {
          return authorization;
        }
        const values = await input.valid();
        const params =
          values.params && typeof values.params === "object" && !Array.isArray(values.params)
            ? values.params
            : {};
        requestState.setBody({
          ...values,
          params: {
            ...params,
            metadata: {
              ...("metadata" in params &&
              params.metadata &&
              typeof params.metadata === "object" &&
              !Array.isArray(params.metadata)
                ? params.metadata
                : {}),
              [BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY]: requestContext.actors,
            },
          },
        });
        return undefined;
      },
    );
    if (createResponse) {
      return createResponse;
    }

    const batchResponse = await ifMatchesRoute(
      "POST",
      "/:workflowName/instances/batch",
      async ({ input, pathParams }) => {
        if (pathParams.workflowName === BACKOFFICE_PI_WORKFLOW_NAME) {
          return error(
            {
              message: "Interactive Pi sessions must be created through the Pi API.",
              code: "WORKFLOW_NOT_FOUND",
            },
            404,
          );
        }
        const authorization = await authorize(BACKOFFICE_PERMISSION.workflow.modify, {
          kind: "workflow",
          workflowName: pathParams.workflowName,
        });
        if (authorization) {
          return authorization;
        }
        const values = await input.valid();
        requestState.setBody({
          ...values,
          instances: values.instances.map((instance) => ({
            ...instance,
            params: {
              ...(instance.params &&
              typeof instance.params === "object" &&
              !Array.isArray(instance.params)
                ? instance.params
                : {}),
              metadata: {
                ...(instance.params &&
                typeof instance.params === "object" &&
                !Array.isArray(instance.params) &&
                "metadata" in instance.params &&
                instance.params.metadata &&
                typeof instance.params.metadata === "object" &&
                !Array.isArray(instance.params.metadata)
                  ? instance.params.metadata
                  : {}),
                [BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY]: requestContext.actors,
              },
            },
          })),
        });
        return undefined;
      },
    );
    if (batchResponse) {
      return batchResponse;
    }

    const readRoutes = [
      ["GET", "/"],
      ["GET", "/:workflowName/instances"],
      ["GET", "/:workflowName/instances/:instanceId"],
      ["GET", "/:workflowName/instances/:instanceId/current-step/emissions"],
      ["GET", "/:workflowName/instances/:instanceId/history"],
    ] as const;
    for (const [method, route] of readRoutes) {
      const response = await ifMatchesRoute(
        method,
        route,
        async ({ pathParams }, _output) =>
          await authorize(BACKOFFICE_PERMISSION.workflow.read, {
            kind: "workflow",
            workflowName: pathParams.workflowName,
          }),
      );
      if (response) {
        return response;
      }
    }

    const mutationRoutes = [
      "/:workflowName/instances/:instanceId/retry",
      "/:workflowName/instances/:instanceId/pause",
      "/:workflowName/instances/:instanceId/resume",
      "/:workflowName/instances/:instanceId/terminate",
      "/:workflowName/instances/:instanceId/events",
    ] as const;
    for (const route of mutationRoutes) {
      const response = await ifMatchesRoute("POST", route, async ({ pathParams }, _output) => {
        if (pathParams.workflowName === BACKOFFICE_PI_WORKFLOW_NAME) {
          return error(
            {
              message: "Interactive Pi sessions must be mutated through the Pi API.",
              code: "WORKFLOW_NOT_FOUND",
            },
            404,
          );
        }
        return await authorize(BACKOFFICE_PERMISSION.workflow.modify, {
          kind: "workflow",
          workflowName: pathParams.workflowName,
          instanceId: pathParams.instanceId,
        });
      });
      if (response) {
        return response;
      }
    }

    return undefined;
  });
  piFragment = pi.createFragment({
    databaseAdapter,
    workflows: workflowsFragment.services,
    mountRoute: "/api/pi",
  });

  automationFragment = createAutomationFragment<BackofficeExecutionContext>(
    {
      env: config.env,
      runtime: config.runtime,
      createPiAutomationContext: async ({ event }) => ({
        runtime: createHostedPiRuntime({
          scope: event.scope,
          actors: event.actors,
        }),
      }),
      automationFileSystem: config.automationFileSystem,
      getAutomationFileSystem: config.getAutomationFileSystem,
      ownerScope: config.ownerScope,
      sandboxProviders: config.sandboxProviders,
    },
    {
      databaseAdapter,
      transactionInstrumentation: runtime.transactionInstrumentation,
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
    piFragment,
    dispatcher: null,
  } satisfies AutomationsRuntime;
};

export const createAutomationsDispatcher = (
  workflowsFragment: ReturnType<typeof createWorkflowsFragment>,
  automationFragment: AutomationFragmentWithExecutionContext,
  state: DurableObjectState,
  env: CloudflareEnv,
  instrumentation: DurableHooksInstrumentation,
): DurableHooksDispatcherDurableObjectHandler => {
  const dispatcherFactory = createDurableHooksProcessor([workflowsFragment, automationFragment], {
    instrumentation,
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
