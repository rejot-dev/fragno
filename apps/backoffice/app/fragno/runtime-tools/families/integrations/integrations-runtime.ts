import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";

import { createConnectorIntegration } from "./connector-integration";
import { createIntegrationRegistry } from "./integration-registry";
import type { IntegrationsRuntime } from "./integration-tools";
import { createReson8Integration } from "./reson8-integration";

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
    createReson8Integration({ runtime, nowEpochMs }),
    ...(execution.scope.kind === "user"
      ? [createConnectorIntegration({ runtime, nowEpochMs })]
      : []),
  ]);
  const context = { kernel, execution };

  return {
    discover: () => registry.discover(context),
    list: ({ cursor }) => registry.list(context, cursor),
    setup: (input) => registry.setup(context, input),
    async get({ connectionId }) {
      const connection = await registry.resolve(context, connectionId);
      return { ...connection.identity, ...(await connection.inspect()) };
    },
    async actions({ connectionId }) {
      const connection = await registry.resolve(context, connectionId);
      return (await connection.actions()).map((action) => action.definition);
    },
    async execute({ connectionId, actionId, input }) {
      const connection = await registry.resolve(context, connectionId);
      const action = (await connection.actions()).find(
        (action) => action.definition.id === actionId,
      );
      if (!action) {
        throw new Error("Integrations action not found.");
      }
      return await action.invoke(input);
    },
    async verify({ connectionId }) {
      const connection = await registry.resolve(context, connectionId);
      return { ...connection.identity, ...(await connection.verify()) };
    },
  };
}
