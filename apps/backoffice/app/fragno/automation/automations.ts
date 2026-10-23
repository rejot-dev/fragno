import {
  automationEntityRefsEqual,
  automationRouteActionAuthority,
  type AutomationRouteAction,
} from "@fragno-dev/backoffice-api/v0/automation";
import {
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";
import {
  createDurableHooksProcessor,
  type DurableHooksDispatcherDurableObjectHandler,
} from "@fragno-dev/db/dispatchers/cloudflare-do";
import type { DurableHooksInstrumentation } from "@fragno-dev/db/hooks";

import { defaultFragnoRuntime } from "@fragno-dev/core";
import { createWorkflowsFragment } from "@fragno-dev/workflows";

import {
  backofficeExecutionScopeRestriction,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";
import {
  BackofficeKernel,
  isBackofficeForbiddenError,
  type BackofficeAuthorizationDenialReason,
  type BackofficeKernelAuthorizationRequirement,
} from "@/backoffice-runtime/kernel";
import { BACKOFFICE_REQUIRED_PERMISSION_HEADER } from "@/backoffice-runtime/required-permission-header";
import { createAutomationFragment, type AutomationFragmentConfig } from "@/fragno/automation";
import { BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY } from "@/fragno/automation/actors";
import {
  CODEMODE_WORKFLOW,
  codemodeWorkflowParamsSchema,
  type CodemodeWorkflowParams,
} from "@/fragno/automation/engine/codemode-invocation";
import { defineCodemodeWorkflow } from "@/fragno/automation/engine/codemode-workflow";
import { listAutomationEventDescriptors } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { piAgentActor } from "@/fragno/pi/agent/pi-agent-actor";
import type { PiAgentNotification } from "@/fragno/pi/agent/pi-agent-contract";
import { createPiManagerRuntime } from "@/fragno/pi/manager/pi-manager-runtime";

import { defineMarketplacePackageInstallWorkflow } from "./marketplace-package-install-workflow.server";
import {
  defineMarketplacePackagePublishWorkflow,
  MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
  type MarketplacePackagePublishWorkflowParams,
} from "./marketplace-package-publish-workflow";
import {
  AutomationRouteMutationAuthorizationError,
  setAutomationRouteMutationActionAuthorizer,
  setAutomationRouteMutationActors,
} from "./route-routes";
import {
  workflowCompletedEventType,
  workflowCompletedNotificationEvent,
  workflowCompletionEventId,
  workflowReplyToSchema,
} from "./workflow-reply";

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
  dispatcher: DurableHooksDispatcherDurableObjectHandler | null;
};

/** Replaces caller-provided security context with the trusted route execution context. */
const withTrustedWorkflowContext = ({
  workflowName,
  params,
  execution,
}: {
  workflowName: string;
  params: Record<string, unknown>;
  execution: BackofficeExecutionContext;
}): Record<string, unknown> => {
  if (workflowName === CODEMODE_WORKFLOW) {
    const trigger =
      params.trigger && typeof params.trigger === "object" && !Array.isArray(params.trigger)
        ? (params.trigger as Record<string, unknown>)
        : {};
    const event =
      trigger.event && typeof trigger.event === "object" && !Array.isArray(trigger.event)
        ? (trigger.event as Record<string, unknown>)
        : {};

    return {
      ...params,
      trigger:
        trigger.type === "event"
          ? {
              ...trigger,
              event: {
                ...event,
                scope: execution.scope,
                scopeRestriction: backofficeExecutionScopeRestriction(execution),
                actors: execution.actors,
              },
            }
          : trigger,
      execution: {
        scope: execution.scope,
        scopeRestriction: backofficeExecutionScopeRestriction(execution),
        actors: execution.actors,
        capabilityGrants: [],
      },
    };
  }

  const metadata =
    params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)
      ? (params.metadata as Record<string, unknown>)
      : {};

  return {
    ...params,
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
    "env" | "runtime" | "readAutomationSource" | "ownerScope"
  > & {
    kernel: BackofficeKernel;
  },
): AutomationsRuntime => {
  const databaseAdapter = runtime.adapters.createAdapter({
    kind: "automations",
  });
  let automationFragment: AutomationFragmentWithExecutionContext | undefined;
  const fragnoRuntime = config.runtime?.fragnoRuntime ?? defaultFragnoRuntime;

  /** A reply carries the run's authority, so the agent admits it as a turn of the run's actors. */
  async function notifyReplyAgent(
    params: CodemodeWorkflowParams,
    agentName: string,
    event: PiAgentNotification["event"],
  ) {
    if (!config.runtime) {
      throw new Error("Notifying agents requires Backoffice runtime services.");
    }
    await createPiManagerRuntime({
      runtime: config.runtime,
      kernel: config.kernel,
      execution: {
        kind: "deferred",
        scope: params.execution.scope,
        scopeRestriction: params.execution.scopeRestriction,
        actors: params.execution.actors,
      },
    }).notifyAgent({ agentName, routeId: null, event });
  }

  const workflowsFragment = createWorkflowsFragment<BackofficeExecutionContext>(
    {
      workflows: {
        CODEMODE_SCRIPT: defineCodemodeWorkflow(config),
        MARKETPLACE_PACKAGE_PUBLISH: defineMarketplacePackagePublishWorkflow({
          ownerScope: config.ownerScope,
          runtime: config.runtime,
        }),
        MARKETPLACE_PACKAGE_INSTALL: defineMarketplacePackageInstallWorkflow({
          ownerScope: config.ownerScope,
          env: config.env,
          runtime: config.runtime,
          getAutomationFragment: () => automationFragment,
          getWorkflowsFragment: (): AutomationsRuntime["workflowsFragment"] => workflowsFragment,
        }),
      },
      runtime: fragnoRuntime,
      onWorkflowTerminal: async function notifyWorkflowOwnerOfTerminalInstance(payload) {
        if (
          config.ownerScope.kind === "system" &&
          payload.workflowName === MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME &&
          (payload.status === "errored" || payload.status === "terminated") &&
          config.runtime
        ) {
          const params = payload.params as MarketplacePackagePublishWorkflowParams;
          const current = await workflowsFragment.callServices(() =>
            workflowsFragment.services.getInstanceStatus(payload.workflowName, payload.instanceId),
          );
          // A delayed terminal hook from an earlier run must not release a restarted publisher.
          if (
            current.runGeneration === payload.runGeneration &&
            current.status === payload.status
          ) {
            await config.runtime.objects.marketplace
              .for(params.request.intent.marketplace)
              .commands.failPackagePublish({
                listingId: params.request.intent.release.listingId,
                version: params.request.intent.release.version,
                workflowInstanceId: payload.instanceId,
              });
          }
        }
        if (payload.workflowName !== CODEMODE_WORKFLOW) {
          return;
        }
        const params = codemodeWorkflowParamsSchema.parse(payload.params);
        const { replyTo } = params;
        if (replyTo === null) {
          return;
        }
        if (replyTo.kind === "agent") {
          await notifyReplyAgent(
            params,
            replyTo.agentName,
            workflowCompletedNotificationEvent({
              terminal: payload,
              workflowName: params.program.workflowName,
              occurredAt: fragnoRuntime.time.now(),
            }),
          );
          return;
        }

        await workflowsFragment.callServices(() =>
          workflowsFragment.services.sendEvent(replyTo.workflowName, replyTo.instanceId, {
            id: workflowCompletionEventId({
              instanceRef: payload.instanceRef,
              runGeneration: payload.runGeneration,
              terminalTransitionId: payload.terminalTransitionId,
            }),
            type: workflowCompletedEventType(payload.runGeneration),
            payload: {
              terminalTransitionId: payload.terminalTransitionId,
              workflowName: payload.workflowName,
              instanceId: payload.instanceId,
              runGeneration: payload.runGeneration,
              status: payload.status,
              ...(payload.output === undefined ? {} : { output: payload.output }),
              ...(payload.error === undefined ? {} : { error: payload.error }),
            },
            ignoreTerminal: true,
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

    const isTrustedSystemExecution =
      requestContext.actors.initiator.scope === "internal" &&
      requestContext.actors.initiator.type === "system" &&
      requestContext.actors.principal === null;

    const rejectInternalWorkflowMutation = (workflowName: string) => {
      if (workflowName === CODEMODE_WORKFLOW || isTrustedSystemExecution) {
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

    const rejectDisallowedWorkflowParams = (
      workflowName: string,
      params: Record<string, unknown>,
    ) => {
      if (!isTrustedSystemExecution && workflowName === CODEMODE_WORKFLOW) {
        const execution =
          params.execution &&
          typeof params.execution === "object" &&
          !Array.isArray(params.execution)
            ? (params.execution as Record<string, unknown>)
            : null;
        if (
          execution &&
          Array.isArray(execution.capabilityGrants) &&
          execution.capabilityGrants.length > 0
        ) {
          return error(
            {
              message: "Codemode capability grants can only be set by internal services.",
              code: "CODEMODE_CAPABILITY_GRANTS_NOT_ALLOWED",
            },
            400,
          );
        }
      }

      if (workflowName === CODEMODE_WORKFLOW && (params.replyTo ?? null) !== null) {
        const replyTo = workflowReplyToSchema.safeParse(params.replyTo).data;
        // A reply to a workflow sends it an event unauthorized, so only internal services set one.
        // A reply to an agent is always news of that agent's own work.
        // The run is created in its agent's scope, which is where the reply is delivered.
        const startingAgent =
          replyTo?.kind === "agent" ? piAgentActor(requestContext.scope, replyTo.agentName) : null;
        const repliesToStartingAgent =
          startingAgent !== null &&
          requestContext.actors.delegation.some((actor) =>
            automationEntityRefsEqual(actor, startingAgent),
          );
        if (!repliesToStartingAgent) {
          return error(
            {
              message: "A workflow can reply only to the agent whose turn starts it.",
              code: "WORKFLOW_REPLY_NOT_ALLOWED",
            },
            400,
          );
        }
      }

      return undefined;
    };

    const authorizeWorkflowOperation = async (
      operation:
        | typeof BACKOFFICE_PERMISSION.workflow.executeCode
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
        if (isBackofficeForbiddenError(cause)) {
          return error(
            { message: cause.message, code: cause.reason },
            AUTOMATIONS_AUTHORIZATION_STATUS_BY_REASON[cause.reason],
            { [BACKOFFICE_REQUIRED_PERMISSION_HEADER]: JSON.stringify(operation) },
          );
        }
        throw cause;
      }
    };

    const authorizeWorkflowCreation = async (workflowName: string) => {
      const resource = { kind: "workflow", workflowName };
      const workflowAuthorization = await authorizeWorkflowOperation(
        BACKOFFICE_PERMISSION.workflow.modify,
        resource,
      );
      if (workflowAuthorization || workflowName !== CODEMODE_WORKFLOW) {
        return workflowAuthorization;
      }
      return await authorizeWorkflowOperation(BACKOFFICE_PERMISSION.workflow.executeCode, resource);
    };

    const createResponse = await ifMatchesRoute(
      "POST",
      "/:workflowName/instances",
      async ({ input, pathParams }) => {
        const internalWorkflowResponse = rejectInternalWorkflowMutation(pathParams.workflowName);
        if (internalWorkflowResponse) {
          return internalWorkflowResponse;
        }

        const authorization = await authorizeWorkflowCreation(pathParams.workflowName);
        if (authorization) {
          return authorization;
        }

        const values = await input.valid();
        const params =
          values.params && typeof values.params === "object" && !Array.isArray(values.params)
            ? (values.params as Record<string, unknown>)
            : {};
        const invalidParamsResponse = rejectDisallowedWorkflowParams(
          pathParams.workflowName,
          params,
        );
        if (invalidParamsResponse) {
          return invalidParamsResponse;
        }

        const trusted = withTrustedWorkflowContext({
          workflowName: pathParams.workflowName,
          params,
          execution: requestContext,
        });
        requestState.setBody({ ...values, params: trusted });
        return undefined;
      },
    );
    if (createResponse) {
      return createResponse;
    }

    const restartOrCreateResponse = await ifMatchesRoute(
      "POST",
      "/:workflowName/instances/:instanceId/restart-or-create",
      async ({ input, pathParams }) => {
        const internalWorkflowResponse = rejectInternalWorkflowMutation(pathParams.workflowName);
        if (internalWorkflowResponse) {
          return internalWorkflowResponse;
        }

        const authorization = await authorizeWorkflowCreation(pathParams.workflowName);
        if (authorization) {
          return authorization;
        }

        const values = await input.valid();
        const params =
          values.create.params &&
          typeof values.create.params === "object" &&
          !Array.isArray(values.create.params)
            ? (values.create.params as Record<string, unknown>)
            : {};
        const invalidParamsResponse = rejectDisallowedWorkflowParams(
          pathParams.workflowName,
          params,
        );
        if (invalidParamsResponse) {
          return invalidParamsResponse;
        }

        const trusted = withTrustedWorkflowContext({
          workflowName: pathParams.workflowName,
          params,
          execution: requestContext,
        });
        requestState.setBody({
          ...values,
          create: { ...values.create, params: trusted },
        });
        return undefined;
      },
    );
    if (restartOrCreateResponse) {
      return restartOrCreateResponse;
    }

    const batchResponse = await ifMatchesRoute(
      "POST",
      "/:workflowName/instances/batch",
      async ({ input, pathParams }) => {
        const internalWorkflowResponse = rejectInternalWorkflowMutation(pathParams.workflowName);
        if (internalWorkflowResponse) {
          return internalWorkflowResponse;
        }

        const authorization = await authorizeWorkflowCreation(pathParams.workflowName);
        if (authorization) {
          return authorization;
        }

        const values = await input.valid();
        const instances = values.instances.map((instance) => ({
          instance,
          params:
            instance.params &&
            typeof instance.params === "object" &&
            !Array.isArray(instance.params)
              ? (instance.params as Record<string, unknown>)
              : {},
        }));
        const trustedInstances = [];
        for (const { instance, params } of instances) {
          const invalidParamsResponse = rejectDisallowedWorkflowParams(
            pathParams.workflowName,
            params,
          );
          if (invalidParamsResponse) {
            return invalidParamsResponse;
          }
          const trusted = withTrustedWorkflowContext({
            workflowName: pathParams.workflowName,
            params,
            execution: requestContext,
          });
          trustedInstances.push({ ...instance, params: trusted });
        }

        requestState.setBody({ ...values, instances: trustedInstances });
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
      ["GET", "/:workflowName/instances/:instanceId/history"],
    ] as const;
    for (const [method, route] of readRoutes) {
      const response = await ifMatchesRoute(
        method,
        route,
        async ({ pathParams }, _output) =>
          await authorizeWorkflowOperation(BACKOFFICE_PERMISSION.workflow.read, {
            kind: "workflow",
            workflowName: pathParams.workflowName,
          }),
      );
      if (response) {
        return response;
      }
    }

    const mutationRoutes = [
      "/:workflowName/instances/:instanceId/retry-failed-step",
      "/:workflowName/instances/:instanceId/pause",
      "/:workflowName/instances/:instanceId/resume",
      "/:workflowName/instances/:instanceId/restart",
      "/:workflowName/instances/:instanceId/terminate",
      "/:workflowName/instances/:instanceId/events",
    ] as const;
    for (const route of mutationRoutes) {
      const response = await ifMatchesRoute("POST", route, async ({ pathParams }, _output) => {
        const internalWorkflowResponse = rejectInternalWorkflowMutation(pathParams.workflowName);
        if (internalWorkflowResponse) {
          return internalWorkflowResponse;
        }

        return await authorizeWorkflowOperation(BACKOFFICE_PERMISSION.workflow.modify, {
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
  automationFragment = createAutomationFragment<BackofficeExecutionContext>(
    {
      builtInEventDefinitions: listAutomationEventDescriptors().map((definition) => ({
        source: definition.source,
        eventType: definition.eventType,
        enabled: true,
        payloadSchema: definition.payloadSchema,
        storedPayload: definition.storedPayload ?? null,
      })),
      env: config.env,
      runtime: config.runtime,
      readAutomationSource: config.readAutomationSource,
      ownerScope: config.ownerScope,
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
    const authorizeAutomationRequirements = async (
      requirements: readonly BackofficeKernelAuthorizationRequirement[],
    ) => {
      if (!requestContext) {
        return error(
          {
            message: "Automations mutation requires trusted action context.",
            code: "AUTOMATIONS_ACTION_CONTEXT_REQUIRED",
          },
          403,
        );
      }

      try {
        await config.kernel.assertAuthorizedAll({ execution: requestContext, requirements });
        return undefined;
      } catch (cause) {
        if (isBackofficeForbiddenError(cause)) {
          return error(
            { message: cause.message, code: cause.reason },
            AUTOMATIONS_AUTHORIZATION_STATUS_BY_REASON[cause.reason],
          );
        }
        throw cause;
      }
    };

    const authorizeAutomationOperation = async (
      operation: BackofficePermissionRequirement,
      resource: Record<string, unknown>,
    ) => await authorizeAutomationRequirements([{ operation, resource }]);

    const authorizeRouteMutation = async ({
      routeId,
      action,
    }: {
      routeId: string;
      action: AutomationRouteAction | undefined;
    }) => {
      const requirements: BackofficeKernelAuthorizationRequirement[] = [
        {
          operation: BACKOFFICE_PERMISSION.router.modify,
          resource: { kind: "automation-route", routeId },
        },
      ];
      const authority = action ? automationRouteActionAuthority(action) : null;
      if (authority && authority.grants !== "inherit") {
        requirements.push(
          ...authority.grants.map((grant) => ({
            operation: grant,
            resource: { kind: "automation-route-grant", routeId, grant },
          })),
        );
      }

      return await authorizeAutomationRequirements(requirements);
    };

    const createRouteResponse = await ifMatchesRoute("POST", "/routes", async ({ input }) => {
      const route = await input.valid();
      const authorization = await authorizeRouteMutation({
        routeId: route.id,
        action: route.action,
      });
      if (authorization || !requestContext) {
        return authorization;
      }
      setAutomationRouteMutationActors(request, requestContext.actors);
      return undefined;
    });
    if (createRouteResponse) {
      return createRouteResponse;
    }

    const updateRouteResponse = await ifMatchesRoute(
      "PATCH",
      "/routes/:routeId",
      async ({ input, pathParams }) => {
        await input.valid();
        const authorization = await authorizeAutomationOperation(
          BACKOFFICE_PERMISSION.router.modify,
          { kind: "automation-route", routeId: pathParams.routeId },
        );
        if (authorization || !requestContext) {
          return authorization;
        }

        const execution = requestContext;
        setAutomationRouteMutationActors(request, execution.actors);
        setAutomationRouteMutationActionAuthorizer(request, async ({ routeId, action }) => {
          const grants = automationRouteActionAuthority(action)?.grants;
          if (grants === undefined || grants === "inherit") {
            return;
          }

          try {
            await config.kernel.assertAuthorizedAll({
              execution,
              requirements: grants.map((grant) => ({
                operation: grant,
                resource: { kind: "automation-route-grant", routeId, grant },
              })),
            });
          } catch (cause) {
            if (isBackofficeForbiddenError(cause)) {
              throw new AutomationRouteMutationAuthorizationError({
                message: cause.message,
                code: cause.reason,
                status: AUTOMATIONS_AUTHORIZATION_STATUS_BY_REASON[cause.reason],
              });
            }
            throw cause;
          }
        });
        return undefined;
      },
    );
    if (updateRouteResponse) {
      return updateRouteResponse;
    }

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
        if (isBackofficeForbiddenError(cause)) {
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
