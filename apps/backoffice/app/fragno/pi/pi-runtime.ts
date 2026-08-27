import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createPiHarness, createPiWorkflows } from "@fragno-dev/pi-harness/factory";
import type { PiFragmentConfig, PiSessionMetadata } from "@fragno-dev/pi-harness/types";
import { createInteractiveChatWorkflow } from "@fragno-dev/pi-harness/workflows/interactive-chat-workflow";
import type { WorkflowAgentHarnessOptions } from "@fragno-dev/pi-harness/workflows/workflow-agent-harness";
import {
  NonRetryableError,
  type WorkflowRegistryEntry,
  type WorkflowsRegistry,
} from "@fragno-dev/workflows/workflow";

import type { WorkflowsFragmentServices } from "@fragno-dev/workflows";

import type { Models } from "@earendil-works/pi-ai";

import type {
  BackofficeContextScope,
  BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import type { BackofficeDatabaseAdapterFactory } from "@/backoffice-runtime/database-adapters";
import { BackofficeForbiddenError, type BackofficeKernel } from "@/backoffice-runtime/kernel";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
import {
  BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY,
  automationActorsSchema,
} from "@/fragno/automation/actors";

import {
  createBackofficeAuthContext,
  createBackofficePiSkillResolver,
  createBackofficeSystemPromptResolver,
  resolveBackofficeWorkflowAgentHarnessOptions,
  resolveDefaultBackofficePiModel,
  validateBackofficePiModel,
  type BackofficePiSkillResolver,
  type BackofficeSystemPromptResolver,
} from "./pi-harness-options";
import {
  BACKOFFICE_PI_WORKFLOW_NAME,
  piSessionBillingOrganizationId,
  piSessionModel,
  PI_BILLING_ORGANIZATION_ID_METADATA_KEY,
  PI_TOOL_IDS,
  type PiApiKeys,
} from "./pi-shared";
import {
  createPiToolFactory,
  type BackofficePiToolFactory,
  type PiCodemodeRuntime,
  type PiRuntimeToolContextSource,
} from "./pi-tools";

export type PiFragment = ReturnType<typeof createPiHarness<BackofficeExecutionContext>>;

export type BackofficeWorkflowAgentHarnessOptionsResolver = (input: {
  sessionId: string;
  execution: BackofficeExecutionContext;
}) => Promise<WorkflowAgentHarnessOptions>;

export type PiRuntimeDefinition = {
  workflows: WorkflowsRegistry;
  resolveWorkflowAgentHarnessOptions: BackofficeWorkflowAgentHarnessOptionsResolver;
  createFragment(input: {
    databaseAdapter: ReturnType<BackofficeDatabaseAdapterFactory["createAdapter"]>;
    workflows: WorkflowsFragmentServices;
    mountRoute?: string;
  }): PiFragment;
};

class PiSessionBillingOwnerMissingError extends NonRetryableError {
  constructor(readonly userId: string) {
    super(`User-scoped Pi session ${userId} has no billing organization.`);
    this.name = "PiSessionBillingOwnerMissingError";
  }
}

class PiSessionBillingOrganizationAccessDeniedError extends NonRetryableError {
  constructor(readonly organizationId: string) {
    super(`Pi session billing organization ${organizationId} is no longer available.`);
    this.name = "PiSessionBillingOrganizationAccessDeniedError";
  }
}

const authorizePiBillingOrganization = async ({
  kernel,
  execution,
  organizationId,
  resource,
}: {
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
  organizationId: string;
  resource: Record<string, unknown>;
}): Promise<void> => {
  await kernel.assertAuthorized({
    execution: {
      ...execution,
      scope: { kind: "org", orgId: organizationId },
    },
    operation: BACKOFFICE_PERMISSION.pi.modify,
    resource,
  });
};

class PiSessionActorMetadataInvalidError extends NonRetryableError {
  constructor() {
    super("PI_SESSION_ACTOR_METADATA_INVALID", "PiSessionActorMetadataInvalidError");
  }
}

export const createBackofficePiSessionExecution = (
  scope: BackofficeContextScope,
  metadata: PiSessionMetadata | null,
): BackofficeExecutionContext => {
  const actors = automationActorsSchema.safeParse(
    metadata?.[BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY],
  );
  if (!actors.success) {
    throw new PiSessionActorMetadataInvalidError();
  }

  return { scope, actors: actors.data };
};

const createBackofficeInteractiveChatWorkflow = ({
  config,
  kernel,
  models,
  createTools,
  skills,
  resolveSystemPrompt,
}: {
  config: { scope: BackofficeContextScope };
  kernel: BackofficeKernel;
  models: Models;
  createTools: BackofficePiToolFactory;
  skills: BackofficePiSkillResolver;
  resolveSystemPrompt: BackofficeSystemPromptResolver;
}): WorkflowRegistryEntry => ({
  ...createInteractiveChatWorkflow({
    name: BACKOFFICE_PI_WORKFLOW_NAME,
    commandTimeout: "1 hour",
    beforeOperation: async (input) => {
      if (config.scope.kind !== "user") {
        return;
      }

      const billingOrganizationId = piSessionBillingOrganizationId(input.metadata);
      if (!billingOrganizationId) {
        throw new PiSessionBillingOwnerMissingError(config.scope.userId);
      }

      try {
        await authorizePiBillingOrganization({
          kernel,
          execution: createBackofficePiSessionExecution(config.scope, input.metadata),
          organizationId: billingOrganizationId,
          resource: {
            kind: "pi-session-operation-billing",
            workflowName: input.workflowName,
            sessionId: input.sessionId,
            operationId: input.operationId,
          },
        });
      } catch (error) {
        if (error instanceof BackofficeForbiddenError && error.reason !== "authority-unavailable") {
          throw new PiSessionBillingOrganizationAccessDeniedError(billingOrganizationId);
        }
        throw error;
      }
    },
    options: async (event) => {
      const selectedModel = piSessionModel(event.payload.metadata);
      if (!selectedModel) {
        throw new Error("BACKOFFICE_PI_MODEL_REQUIRED");
      }

      const metadata = event.payload.metadata ?? null;
      const execution = createBackofficePiSessionExecution(config.scope, metadata);
      const sessionTools = await createTools({
        sessionId: event.instanceId,
        execution,
        metadata,
      });
      const activeTools = PI_TOOL_IDS.map((toolId) => {
        const tool = sessionTools[toolId];
        if (!tool) {
          throw new Error(`${toolId} is not configured for this Pi runtime.`);
        }
        return tool;
      });
      return await resolveBackofficeWorkflowAgentHarnessOptions({
        models,
        tools: activeTools,
        skills,
        resolveSystemPrompt,
        sessionId: event.instanceId,
        execution,
        selectedModel,
        systemPrompt: event.payload.systemPrompt,
        thinkingLevel: event.payload.thinkingLevel,
      });
    },
  }),
  checkpoint: "step",
});

const buildPiRuntime = (
  config: { scope: BackofficeContextScope },
  kernel: BackofficeKernel,
  apiKeys: PiApiKeys,
  createTools: BackofficePiToolFactory,
  skills: BackofficePiSkillResolver,
  resolveSystemPrompt: BackofficeSystemPromptResolver,
  onOperationCompleted: PiFragmentConfig["onOperationCompleted"],
) => {
  const models = builtinModels({
    authContext: createBackofficeAuthContext(apiKeys),
  });
  const workflows = [
    createBackofficeInteractiveChatWorkflow({
      config,
      kernel,
      models,
      createTools,
      skills,
      resolveSystemPrompt,
    }),
  ];
  const piConfig = {
    workflows,
    logging: { enabled: true, level: "debug" },
    onOperationCompleted,
  } satisfies PiFragmentConfig;

  const resolveWorkflowAgentHarnessOptions: BackofficeWorkflowAgentHarnessOptionsResolver = async ({
    sessionId,
    execution,
  }) => {
    const selectedModel = await resolveDefaultBackofficePiModel(models);
    if (!selectedModel) {
      throw new Error("No configured Pi model is available.");
    }

    return await resolveBackofficeWorkflowAgentHarnessOptions({
      models,
      tools: [],
      skills,
      resolveSystemPrompt,
      sessionId,
      execution,
      selectedModel,
    });
  };

  return {
    config: piConfig,
    models,
    workflows: createPiWorkflows(piConfig),
    resolveWorkflowAgentHarnessOptions,
  };
};

export type CreatePiRuntimeDefinitionOptions = {
  scope: BackofficeContextScope;
  apiKeys: PiApiKeys;
  kernel: BackofficeKernel;
  runtimeToolContext: PiRuntimeToolContextSource;
  codemode: PiCodemodeRuntime;
  onOperationCompleted?: PiFragmentConfig["onOperationCompleted"];
};

export const createPiRuntimeDefinition = (
  options: CreatePiRuntimeDefinitionOptions,
): PiRuntimeDefinition => {
  const codemode = options.codemode;
  const createTools = createPiToolFactory({
    codemode,
    runtimeToolContext: options.runtimeToolContext,
  });
  const skills = createBackofficePiSkillResolver(options.runtimeToolContext);
  const resolveSystemPrompt = createBackofficeSystemPromptResolver(options.runtimeToolContext);
  const pi = buildPiRuntime(
    { scope: options.scope },
    options.kernel,
    options.apiKeys,
    createTools,
    skills,
    resolveSystemPrompt,
    options.onOperationCompleted,
  );

  const createFragment: PiRuntimeDefinition["createFragment"] = ({
    databaseAdapter,
    workflows,
    mountRoute = "/api/pi",
  }) =>
    createPiHarness<BackofficeExecutionContext>(
      pi.config,
      {
        databaseAdapter,
        mountRoute,
        outbox: { enabled: true },
      },
      { workflows },
    ).withMiddleware(async function authorizePiSessionRoutes(
      { ifMatchesRoute, requestContext, requestState },
      { error },
    ) {
      const authorize = async (
        operation: typeof BACKOFFICE_PERMISSION.pi.read | typeof BACKOFFICE_PERMISSION.pi.modify,
        resource: Record<string, unknown>,
        execution = requestContext,
      ) => {
        if (!execution) {
          return error(
            {
              message: "Pi session routes require trusted action context.",
              code: "context-access-denied",
            },
            403,
          );
        }

        try {
          await options.kernel.assertAuthorized({
            execution,
            operation,
            resource,
          });
          return undefined;
        } catch (cause) {
          if (cause instanceof BackofficeForbiddenError) {
            return error(
              { message: cause.message, code: cause.reason },
              cause.reason === "authority-unavailable" ? 503 : 403,
            );
          }
          throw cause;
        }
      };

      const createResponse = await ifMatchesRoute(
        "POST",
        "/workflows/:workflowName/sessions",
        async ({ input, pathParams }) => {
          const values = await input.valid();
          let model = piSessionModel(values.metadata);
          if (pathParams.workflowName === BACKOFFICE_PI_WORKFLOW_NAME) {
            if (!model) {
              model = await resolveDefaultBackofficePiModel(pi.models);
            }
            if (!model) {
              return error(
                {
                  message: "No configured Pi model is available.",
                  code: "WORKFLOW_PARAMS_INVALID",
                },
                400,
              );
            }

            const message = validateBackofficePiModel(pi.models, model);
            if (message) {
              return error({ message, code: "WORKFLOW_PARAMS_INVALID" }, 400);
            }
          }

          const authorizationResponse = await authorize(BACKOFFICE_PERMISSION.pi.modify, {
            kind: "pi-session-create",
            workflowName: pathParams.workflowName,
            model,
          });
          if (authorizationResponse || !requestContext) {
            return authorizationResponse;
          }

          const billingOrganizationId = piSessionBillingOrganizationId(values.metadata);
          if (requestContext.scope.kind === "user") {
            if (!billingOrganizationId) {
              return error(
                {
                  message: "User-scoped Pi sessions require a billing organization.",
                  code: "WORKFLOW_PARAMS_INVALID",
                },
                400,
              );
            }
            const billingAuthorizationResponse = await authorize(
              BACKOFFICE_PERMISSION.pi.modify,
              {
                kind: "pi-session-billing-organization",
                workflowName: pathParams.workflowName,
                organizationId: billingOrganizationId,
              },
              {
                ...requestContext,
                scope: { kind: "org", orgId: billingOrganizationId },
              },
            );
            if (billingAuthorizationResponse) {
              return billingAuthorizationResponse;
            }
          }

          const {
            [PI_BILLING_ORGANIZATION_ID_METADATA_KEY]: _requestedBillingOrganizationId,
            ...sessionMetadata
          } = values.metadata ?? {};
          requestState.setBody({
            ...values,
            metadata: {
              ...sessionMetadata,
              model,
              ...(requestContext.scope.kind === "user" && billingOrganizationId
                ? { [PI_BILLING_ORGANIZATION_ID_METADATA_KEY]: billingOrganizationId }
                : {}),
              [BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY]: automationActorsSchema.parse(
                requestContext.actors,
              ),
            },
          });
          return undefined;
        },
      );
      if (createResponse) {
        return createResponse;
      }

      const readRoutes = [
        "/workflows/:workflowName/sessions",
        "/workflows/:workflowName/sessions/:sessionId",
        "/workflows/:workflowName/sessions/:sessionId/export/pi-jsonl",
        "/workflows/:workflowName/sessions/:sessionId/wait-for-agent-end",
      ] as const;
      for (const route of readRoutes) {
        const response = await ifMatchesRoute(
          "GET",
          route,
          async ({ pathParams }, _output) =>
            await authorize(BACKOFFICE_PERMISSION.pi.read, {
              kind: pathParams.sessionId ? "pi-session" : "pi-session-list",
              workflowName: pathParams.workflowName,
              sessionId: pathParams.sessionId,
            }),
        );
        if (response) {
          return response;
        }
      }

      return await ifMatchesRoute(
        "POST",
        "/workflows/:workflowName/sessions/:sessionId/command",
        async ({ pathParams }) =>
          await authorize(BACKOFFICE_PERMISSION.pi.modify, {
            kind: "pi-session",
            workflowName: pathParams.workflowName,
            sessionId: pathParams.sessionId,
          }),
      );
    });

  return {
    workflows: pi.workflows,
    resolveWorkflowAgentHarnessOptions: pi.resolveWorkflowAgentHarnessOptions,
    createFragment,
  };
};
