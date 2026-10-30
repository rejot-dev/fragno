import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { backofficeContextScopesEqual } from "@fragno-dev/backoffice-api/v0/shared/scope";

import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import {
  backofficeExecutionScopeRestriction,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeForbiddenError, type BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  piAgentCompactionSchema,
  piAgentNotificationEvent,
  piAgentNotificationSchema,
  type PiAgentSettledTurn,
} from "@/fragno/pi/agent/pi-agent-contract";

import { handOverPiAgentWork, publishPiAgentQueue } from "./pi-agent-queue";
import { piManagerConversationRoutes } from "./pi-manager-conversation-routes";
import { piManagerDefinition, type PiManagerConfig } from "./pi-manager-definition";
import { piManagerDirectoryRoutes } from "./pi-manager-directory-routes";
import { piManagerTurnRoutes, promptRequestSchema } from "./pi-manager-turn-routes";

type PiManagerRequestContext = {
  execution: BackofficeExecutionContext;
};

/** Authorizes every scoped directory request with trusted execution context and Pi permissions. */
export function createPiManagerFragment(
  config: PiManagerConfig,
  options: FragnoPublicConfigWithDatabase,
  kernel: BackofficeKernel,
) {
  return instantiate(piManagerDefinition)
    .withConfig(config)
    .withRoutes([piManagerDirectoryRoutes, piManagerTurnRoutes, piManagerConversationRoutes])
    .withRequestContext<PiManagerRequestContext>()
    .withOptions(options)
    .build()
    .withMiddleware(async function authorizePiManager(
      { requestContext, method, path, ifMatchesRoute, requestState },
      { error },
    ) {
      if (
        !requestContext ||
        !backofficeContextScopesEqual(requestContext.execution.scope, config.scope)
      ) {
        return error(
          {
            code: "context-access-denied",
            message: "Pi manager requires matching scope action context.",
          },
          403,
        );
      }
      async function authorize(
        execution: BackofficeExecutionContext,
        operation: (typeof BACKOFFICE_PERMISSION.pi)[keyof typeof BACKOFFICE_PERMISSION.pi],
        resource: Record<string, unknown>,
      ) {
        try {
          await kernel.assertAuthorized({ execution, operation, resource });
          return undefined;
        } catch (cause) {
          if (cause instanceof BackofficeForbiddenError) {
            return error(
              { code: cause.reason, message: cause.message },
              cause.reason === "authority-unavailable" ? 503 : 403,
            );
          }
          throw cause;
        }
      }
      const changesDefinitions =
        (method === "POST" && path === "/agents") ||
        ((method === "PUT" || method === "DELETE") && path === "/agents/:agentName");
      const denied = await authorize(
        requestContext.execution,
        method === "GET"
          ? BACKOFFICE_PERMISSION.pi.read
          : changesDefinitions
            ? BACKOFFICE_PERMISSION.pi.manage
            : BACKOFFICE_PERMISSION.pi.modify,
        { kind: "pi-agent-directory", scope: config.scope },
      );
      if (denied) {
        return denied;
      }
      // Persisted turn authority is identity only; temporary request authority never leaves here.
      const provenance = {
        actors: requestContext.execution.actors,
        scopeRestriction: backofficeExecutionScopeRestriction(requestContext.execution),
      };
      // Agent changes are recorded as events attributed to whoever made them.
      if (
        changesDefinitions ||
        (method === "POST" &&
          (path === "/agents/:agentName/stop" || path === "/agents/:agentName/resume"))
      ) {
        const body = requestState.body;
        requestState.setBody({
          ...(typeof body === "object" && body !== null ? body : {}),
          provenance,
        });
        return undefined;
      }
      const prompted = await ifMatchesRoute("POST", "/agents/:agentName/prompts", async () => {
        const parsed = promptRequestSchema.safeParse(requestState.body);
        if (!parsed.success) {
          return error({ code: "INVALID_PROMPT", message: parsed.error.message }, 400);
        }
        const values = parsed.data;
        requestState.setBody({
          ...values,
          requestId: values.requestId ?? crypto.randomUUID(),
          provenance,
        });
        return undefined;
      });
      if (prompted) {
        return prompted;
      }
      const notified = await ifMatchesRoute(
        "POST",
        "/agents/:agentName/notifications",
        async () => {
          const parsed = piAgentNotificationSchema.safeParse(requestState.body);
          if (!parsed.success) {
            return error({ code: "INVALID_NOTIFICATION", message: parsed.error.message }, 400);
          }
          requestState.setBody({ ...parsed.data, provenance });
          return undefined;
        },
      );
      if (notified) {
        return notified;
      }
      return await ifMatchesRoute("POST", "/agents/:agentName/compact", async () => {
        const parsed = piAgentCompactionSchema.safeParse(requestState.body);
        if (!parsed.success) {
          return error({ code: "INVALID_COMPACTION", message: parsed.error.message }, 400);
        }
        requestState.setBody({ ...parsed.data, provenance });
        return undefined;
      });
    });
}

/** Called for every turn an agent settles, so its queue hands it the next turn. */
export async function reportPiAgentTurnSettled(
  fragment: ReturnType<typeof createPiManagerFragment>,
  config: Pick<PiManagerConfig, "scope" | "agent" | "supportedAvailableModels">,
  input: PiAgentSettledTurn,
): Promise<void> {
  const availableModels = await config.supportedAvailableModels();
  const advanced = await fragment.callServices(() =>
    fragment.services.advanceAgentQueue({
      agentName: input.agentName,
      settledRequestId: input.requestId,
      ended: input.ended && piAgentNotificationEvent(input.ended),
      compact: input.compact,
      availableModels,
    }),
  );
  if (!advanced) {
    return;
  }
  await publishPiAgentQueue(
    config.agent({ scope: config.scope, agentName: input.agentName }),
    advanced.queue,
  );
  for (const handover of advanced.handovers) {
    await handOverPiAgentWork(config.agent, handover);
  }
}
