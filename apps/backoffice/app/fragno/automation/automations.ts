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
import { defineAutomationCodemodeWorkflow } from "@/fragno/automation/engine/automation-codemode-workflow";
import {
  definePiCodemodeWorkflow,
  PI_CODEMODE_WORKFLOW,
} from "@/fragno/automation/engine/pi-codemode-workflow";
import { defineUntrustedCodemodeWorkflow } from "@/fragno/automation/engine/untrusted-codemode-workflow";
import { AUTOMATION_CODEMODE_WORKFLOW } from "@/fragno/automation/engine/workflow-start";
import {
  createPiRuntimeDefinition,
  type CreatePiRuntimeDefinitionOptions,
  type PiFragment,
  type PiRuntimeToolContext,
} from "@/fragno/pi/pi";
import {
  createPiFragmentRuntime,
  type PiRuntime,
} from "@/fragno/runtime-tools/families/pi-runtime";

import { defineMarketplaceIngestWorkflow } from "./marketplace-ingest-workflow";
import { defineMarketplacePublishWorkflow } from "./marketplace-publish-workflow";
import { setAutomationRouteMutationActors } from "./route-routes";
import { defineSandboxLifecycleWorkflow } from "./sandbox-lifecycle-workflow";
import { SANDBOX_LIFECYCLE_WORKFLOW_NAME } from "./sandboxes-storage-runtime";
import {
  parseWorkflowCompletionTarget,
  WORKFLOW_COMPLETED_EVENT_TYPE,
  WORKFLOW_COMPLETION_PARAM,
} from "./workflow-completion";

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Derives security-sensitive workflow context from the trusted route execution. */
const withTrustedWorkflowContext = ({
  workflowName,
  params,
  execution,
}: {
  workflowName: string;
  params: Record<string, unknown>;
  execution: BackofficeExecutionContext;
}): Record<string, unknown> => {
  const automationEvent = isRecord(params.automationEvent) ? params.automationEvent : null;
  const metadata = isRecord(params.metadata) ? params.metadata : {};

  return {
    ...params,
    ...(workflowName === AUTOMATION_CODEMODE_WORKFLOW && automationEvent
      ? {
          automationEvent: {
            ...automationEvent,
            scope: execution.scope,
            actors: execution.actors,
          },
        }
      : {}),
    metadata: {
      ...metadata,
      [BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY]: execution.actors,
    },
  };
};

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
          createPiAutomationContext: ({ execution }) => ({
            runtime: createHostedPiRuntime(execution),
          }),
        }),
        UNTRUSTED_CODEMODE_SCRIPT: defineUntrustedCodemodeWorkflow({
          ...config,
          createPiAutomationContext: ({ execution }) => ({
            runtime: createHostedPiRuntime(execution),
          }),
        }),
        PI_CODEMODE_SCRIPT: definePiCodemodeWorkflow(config),
        MARKETPLACE_PUBLISH: defineMarketplacePublishWorkflow({
          ownerScope: config.ownerScope,
          runtime: config.runtime,
        }),
        MARKETPLACE_INGEST: defineMarketplaceIngestWorkflow({
          ownerScope: config.ownerScope,
          env: config.env,
          runtime: config.runtime,
          automationFileSystem: config.automationFileSystem,
          getAutomationFileSystem: config.getAutomationFileSystem,
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
        if (payload.workflowName === SANDBOX_LIFECYCLE_WORKFLOW_NAME) {
          if (!automationFragment) {
            throw new Error("Sandbox lifecycle terminal hook requires the automations fragment.");
          }

          const fragment = automationFragment;
          await fragment.callServices(() =>
            fragment.services.stopSandboxInstanceForTerminalWorkflow({
              workflowInstanceId: payload.instanceId,
            }),
          );
        }

        const completionTarget = parseWorkflowCompletionTarget(payload.params);
        if (!completionTarget) {
          return;
        }

        await workflowsFragment.callServices(() =>
          workflowsFragment.services.sendEvent(
            completionTarget.workflowName,
            completionTarget.instanceId,
            {
              id: `workflow-completed:${payload.instanceRef}`,
              type: WORKFLOW_COMPLETED_EVENT_TYPE,
              payload: {
                workflowName: payload.workflowName,
                instanceId: payload.instanceId,
                status: payload.status,
                ...(payload.output === undefined ? {} : { output: payload.output }),
                ...(payload.error === undefined ? {} : { error: payload.error }),
              },
              ignoreTerminal: true,
            },
          ),
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

    const rejectNonPublicWorkflowMutation = (workflowName: string) => {
      const isTrustedSystemExecution =
        requestContext.actors.initiator.scope === "internal" &&
        requestContext.actors.initiator.type === "system" &&
        requestContext.actors.principal === null;
      if (
        workflowName === AUTOMATION_CODEMODE_WORKFLOW ||
        workflowName === PI_CODEMODE_WORKFLOW ||
        isTrustedSystemExecution
      ) {
        return undefined;
      }

      return error(
        {
          message: "This workflow can only be mutated through its owning internal service.",
          code: "WORKFLOW_NOT_FOUND",
        },
        404,
      );
    };

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
        const internalWorkflowResponse = rejectNonPublicWorkflowMutation(pathParams.workflowName);
        if (internalWorkflowResponse) {
          return internalWorkflowResponse;
        }
        const authorization = await authorize(BACKOFFICE_PERMISSION.workflow.modify, {
          kind: "workflow",
          workflowName: pathParams.workflowName,
        });
        if (authorization) {
          return authorization;
        }
        const values = await input.valid();
        const params = isRecord(values.params) ? values.params : {};
        if (Object.hasOwn(params, WORKFLOW_COMPLETION_PARAM)) {
          return error(
            {
              message: "Workflow completion targets can only be set by internal services.",
              code: "WORKFLOW_COMPLETION_TARGET_NOT_ALLOWED",
            },
            400,
          );
        }
        requestState.setBody({
          ...values,
          params: withTrustedWorkflowContext({
            workflowName: pathParams.workflowName,
            params,
            execution: requestContext,
          }),
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
        const internalWorkflowResponse = rejectNonPublicWorkflowMutation(pathParams.workflowName);
        if (internalWorkflowResponse) {
          return internalWorkflowResponse;
        }
        const authorization = await authorize(BACKOFFICE_PERMISSION.workflow.modify, {
          kind: "workflow",
          workflowName: pathParams.workflowName,
        });
        if (authorization) {
          return authorization;
        }
        const values = await input.valid();
        if (
          values.instances.some(
            ({ params }) =>
              params &&
              typeof params === "object" &&
              !Array.isArray(params) &&
              Object.hasOwn(params, WORKFLOW_COMPLETION_PARAM),
          )
        ) {
          return error(
            {
              message: "Workflow completion targets can only be set by internal services.",
              code: "WORKFLOW_COMPLETION_TARGET_NOT_ALLOWED",
            },
            400,
          );
        }
        requestState.setBody({
          ...values,
          instances: values.instances.map((instance) => ({
            ...instance,
            params: withTrustedWorkflowContext({
              workflowName: pathParams.workflowName,
              params: isRecord(instance.params) ? instance.params : {},
              execution: requestContext,
            }),
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
        const internalWorkflowResponse = rejectNonPublicWorkflowMutation(pathParams.workflowName);
        if (internalWorkflowResponse) {
          return internalWorkflowResponse;
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
      createPiAutomationContext: async ({ execution }) => ({
        runtime: createHostedPiRuntime(execution),
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
  ).withMiddleware(async function authorizeAutomationMutations(
    { ifMatchesRoute, request, requestContext },
    { error },
  ) {
    const attachRouteMutationActors = () => {
      if (requestContext) {
        setAutomationRouteMutationActors(request, requestContext.actors);
      }
    };

    await ifMatchesRoute("POST", "/routes", attachRouteMutationActors);
    await ifMatchesRoute("PATCH", "/routes/:routeId", attachRouteMutationActors);

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
