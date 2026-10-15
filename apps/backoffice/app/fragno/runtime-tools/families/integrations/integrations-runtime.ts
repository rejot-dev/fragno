import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";

import { createApiIntegration } from "./api-integration";
import { createConnectorIntegration } from "./connector-integration";
import { createGitHubIntegration } from "./github-integration";
import { recordIntegrationConnectionState } from "./integration-events";
import { createIntegrationRegistry } from "./integration-registry";
import type { IntegrationsRuntime } from "./integration-tools";
import { createMcpIntegration } from "./mcp-integration";
import { createResendIntegration } from "./resend-integration";
import { createReson8Integration } from "./reson8-integration";
import { createTelegramIntegration } from "./telegram-integration";
import { createWebhookIntegration } from "./webhook-integration";

/** Every request resolves deterministic addresses against the selected scope's authoritative source. */
export function createIntegrationsRuntime({
  runtime,
  kernel,
  execution,
  nowEpochMs,
}: {
  runtime: Pick<BackofficeRuntimeServices, "objects" | "config">;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
  nowEpochMs: () => number;
}): IntegrationsRuntime {
  const registry = createIntegrationRegistry([
    createApiIntegration({ runtime }),
    createWebhookIntegration({ runtime }),
    createMcpIntegration({ runtime, nowEpochMs }),
    createGitHubIntegration({ runtime, nowEpochMs }),
    createReson8Integration({ runtime, nowEpochMs }),
    createTelegramIntegration({ runtime, nowEpochMs }),
    createResendIntegration({ runtime, nowEpochMs }),
    ...(execution.scope.kind === "user"
      ? [createConnectorIntegration({ runtime, nowEpochMs })]
      : []),
  ]);
  const context = { kernel, execution };

  return {
    discover: () => registry.discover(context),
    list: ({ cursor }) => registry.list(context, cursor),
    setup: (input) => registry.setup(context, input),
    reconfigure: (input) => registry.reconfigure(context, input),
    disconnect: ({ connectionId }) => registry.disconnect(context, connectionId),
    async backfillConnectionEvents() {
      const automations = runtime.objects.automations.for(execution.scope).commands;
      const connections = [];
      let cursor: string | null = null;
      do {
        const page = await registry.list(context, cursor);
        // A backfill reports every configured connection, so a skipped source fails it; a rerun
        // records nothing already recorded.
        const [unavailable] = page.unavailableSources;
        if (unavailable) {
          throw new BackofficeOperationError(
            "operation_failed",
            `Integrations source ${unavailable.source} could not list: ${unavailable.reason}`,
          );
        }
        for (const { connectionId, integrationId, name, authMethod } of page.connections) {
          const state = await (await registry.resolve(context, connectionId)).state();
          await recordIntegrationConnectionState(
            automations,
            {
              // Stable per connection and label, so a rerun repeats no state an earlier backfill
              // recorded, but records a renamed connection or one recorded before events had labels.
              id: `integrations-backfill:${connectionId}:${JSON.stringify([name, authMethod])}`,
              scope: execution.scope,
              service: integrationId,
              connectionId,
              state,
              label: { name, authMethod },
              occurredAt: new Date(nowEpochMs()),
            },
            { propagationContext: null },
          );
          connections.push({ connectionId, service: integrationId, state });
        }
        cursor = page.cursor;
      } while (cursor !== null);
      return { connections };
    },
    async get({ connectionId }) {
      const connection = await registry.resolve(context, connectionId);
      const [inspection, settings] = await Promise.all([
        connection.inspect(),
        connection.settings(),
      ]);
      return { ...connection.identity, ...inspection, settings };
    },
    async actions({ connectionId }) {
      const connection = await registry.resolve(context, connectionId);
      return (await connection.actions()).map((action) => action.definition);
    },
    async execute({ connectionId, actionId, input, unchecked }) {
      const connection = await registry.resolve(context, connectionId);
      const action = (await connection.actions()).find(
        (action) => action.definition.id === actionId,
      );
      if (!action) {
        throw new BackofficeOperationError("not_found", "Integrations action not found.");
      }
      const { validation } = action.definition;
      if (validation.kind === "unchecked" && !unchecked) {
        throw new BackofficeOperationError(
          "invalid_request",
          `Action '${actionId}' is unchecked: ${validation.reason} Pass unchecked: true to run it without validation.`,
        );
      }
      return await action.invoke(input);
    },
    async describe({ connectionId }) {
      // No tool wraps this read, so it checks the permission integrations.get requires itself.
      await kernel.assertAuthorized({
        execution,
        operation: BACKOFFICE_PERMISSION.integrations.read,
        resource: { connectionId },
      });
      const connection = await registry.resolve(context, connectionId);
      const [inspection, details] = await Promise.all([connection.inspect(), connection.details()]);
      return { connection: { ...connection.identity, ...inspection }, details };
    },
    async verify({ connectionId }) {
      const connection = await registry.resolve(context, connectionId);
      return { ...connection.identity, ...(await connection.verify()) };
    },
  };
}
