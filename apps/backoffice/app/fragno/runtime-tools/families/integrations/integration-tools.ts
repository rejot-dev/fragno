import { z } from "zod";

import { backofficeContextScopesEqual } from "@/backoffice-runtime/context";
import { jsonValueSchema, type JsonValue } from "@/lib/zod/json-value";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../../runtime-tools";
import {
  integrationActionSchema,
  integrationConnectionSchema,
  integrationConnectInputSchema,
  integrationContinueSetupInputSchema,
  integrationExecuteInputSchema,
  integrationListInputSchema,
  integrationListOutputSchema,
  integrationOverviewSchema,
  integrationReferenceInputSchema,
  integrationSetupProgressSchema,
} from "./integration-contracts";

/**
 * Backend contract for generated integration tools; no production implementation exists yet.
 * Runtimes are bound to the selected execution scope. Binding and setup handles must resolve to
 * that owner; a caller-supplied scope is not proof of ownership. Setup responses must match the
 * attempt's current requirement; expired attempts never restart silently.
 * Backends own setup orchestration and validate action input/results against authoritative contracts.
 * Per-action and adapter permissions still apply: an umbrella execution grant is not blanket access.
 * Setup and inspection results must not disclose credentials or private adapter identifiers.
 */
export type IntegrationsRuntime = {
  discover(): Promise<z.output<typeof integrationOverviewSchema>[]>;
  list(
    input: z.output<typeof integrationListInputSchema>,
  ): Promise<z.output<typeof integrationListOutputSchema>>;
  get(
    input: z.output<typeof integrationReferenceInputSchema>,
  ): Promise<z.output<typeof integrationConnectionSchema>>;
  /** Singleton connect reuses a binding or nonterminal attempt; names never create configuration copies. */
  connect(
    input: z.output<typeof integrationConnectInputSchema>,
  ): Promise<z.output<typeof integrationSetupProgressSchema>>;
  continueSetup(
    input: z.output<typeof integrationContinueSetupInputSchema>,
  ): Promise<z.output<typeof integrationSetupProgressSchema>>;
  actions(
    input: z.output<typeof integrationReferenceInputSchema>,
  ): Promise<z.output<typeof integrationActionSchema>[]>;
  execute(input: z.output<typeof integrationExecuteInputSchema>): Promise<JsonValue>;
  verify(
    input: z.output<typeof integrationReferenceInputSchema>,
  ): Promise<z.output<typeof integrationConnectionSchema>>;
  disconnect(input: z.output<typeof integrationReferenceInputSchema>): Promise<void>;
};
type IntegrationsToolContext = BackofficeToolContext<{
  integrations: IntegrationsRuntime | undefined;
}>;

function requireIntegrationsRuntime(context: IntegrationsToolContext): IntegrationsRuntime {
  if (!context.runtimes.integrations) {
    throw new Error("Integrations runtime is not implemented in this execution context.");
  }
  return context.runtimes.integrations;
}

function assertIntegrationReferenceScope(
  input: z.output<typeof integrationReferenceInputSchema>,
  context: IntegrationsToolContext,
): void {
  if (!backofficeContextScopesEqual(input.reference.scope, context.execution.scope)) {
    throw new Error(
      "Integrations reference scope mismatch: use a provider bound to the integration owner.",
    );
  }
}

/** Unregistered integration tool-family sketch; register it once a production backend exists. */
export const integrationsToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "integrations",
  permissions: {
    read: "Discover services and actions, and inspect scoped integration state.",
    manage: "Connect, continue setup, verify, and disconnect scoped integrations.",
    execute: "Dispatch scoped integration actions, subject to their own authorization checks.",
  },
  isAvailable: (context: IntegrationsToolContext) => !!context.runtimes.integrations,
  tools: [
    defineBackofficeRuntimeTool({
      id: "integrations.discover",
      namespace: "integrations",
      name: "discover",
      description:
        "Discover services that can be integrated in the selected scope, including unconfigured services, without choosing an integration mechanism.",
      requiredPermissions: ["read"],
      inputSchema: z.void(),
      outputSchema: z.array(integrationOverviewSchema),
      execute: async (_input, context: IntegrationsToolContext) =>
        await requireIntegrationsRuntime(context).discover(),
    }),
    defineBackofficeRuntimeTool({
      id: "integrations.list",
      namespace: "integrations",
      name: "list",
      description:
        "List configured integrations in the selected scope, one cursor page at a time. Configuration does not imply live service access.",
      requiredPermissions: ["read"],
      inputSchema: integrationListInputSchema,
      outputSchema: integrationListOutputSchema,
      execute: async (input, context: IntegrationsToolContext) =>
        await requireIntegrationsRuntime(context).list(input),
    }),
    defineBackofficeRuntimeTool({
      id: "integrations.get",
      namespace: "integrations",
      name: "get",
      description:
        "Inspect a binding's configuration state, authorization, and previous check evidence using its returned reference. References never switch scope.",
      requiredPermissions: ["read"],
      inputSchema: integrationReferenceInputSchema,
      outputSchema: integrationConnectionSchema,
      getResource: (input) => input.reference,
      execute: async (input, context: IntegrationsToolContext) => {
        assertIntegrationReferenceScope(input, context);
        return await requireIntegrationsRuntime(context).get(input);
      },
    }),
    defineBackofficeRuntimeTool({
      id: "integrations.connect",
      namespace: "integrations",
      name: "connect",
      description:
        "Connect a service in the selected scope. Singleton services reuse their existing binding or in-progress setup without renaming or replacing shared configuration; otherwise start setup. The runtime owns the integration mechanism.",
      requiredPermissions: ["manage"],
      inputSchema: integrationConnectInputSchema,
      outputSchema: integrationSetupProgressSchema,
      getResource: (input) => ({ integrationId: input.integrationId }),
      execute: async (input, context: IntegrationsToolContext) =>
        await requireIntegrationsRuntime(context).connect(input),
    }),
    defineBackofficeRuntimeTool({
      id: "integrations.continueSetup",
      namespace: "integrations",
      name: "continueSetup",
      description:
        "Resume an existing scope-owned setup attempt by submitting requested input or checking authoritative external state. User confirmation is not proof of consent; expired attempts do not restart silently.",
      requiredPermissions: ["manage"],
      inputSchema: integrationContinueSetupInputSchema,
      outputSchema: integrationSetupProgressSchema,
      getResource: (input) => ({ setupId: input.setupId }),
      execute: async (input, context: IntegrationsToolContext) =>
        await requireIntegrationsRuntime(context).continueSetup(input),
    }),
    defineBackofficeRuntimeTool({
      id: "integrations.actions",
      namespace: "integrations",
      name: "actions",
      description:
        "Discover a binding's supported actions and authoritative input/output schemas without executing them. No schemas are inferred from action names or adapter identifiers.",
      requiredPermissions: ["read"],
      inputSchema: integrationReferenceInputSchema,
      outputSchema: z.array(integrationActionSchema),
      getResource: (input) => input.reference,
      execute: async (input, context: IntegrationsToolContext) => {
        assertIntegrationReferenceScope(input, context);
        return await requireIntegrationsRuntime(context).actions(input);
      },
    }),
    defineBackofficeRuntimeTool({
      id: "integrations.execute",
      namespace: "integrations",
      name: "execute",
      description:
        "Execute a discovered action with JSON input and output. Schema-declared binary fields use integer byte arrays, never native buffers. The runtime validates the live action contract and enforces action-specific permissions; the result retains the action's own domain and asynchronous semantics.",
      requiredPermissions: ["execute"],
      inputSchema: integrationExecuteInputSchema,
      outputSchema: jsonValueSchema.meta({ codemodeType: "JsonValue" }),
      getResource: (input) => ({ reference: input.reference, actionId: input.actionId }),
      execute: async (input, context: IntegrationsToolContext) => {
        assertIntegrationReferenceScope(input, context);
        return await requireIntegrationsRuntime(context).execute(input);
      },
    }),
    defineBackofficeRuntimeTool({
      id: "integrations.verify",
      namespace: "integrations",
      name: "verify",
      description:
        "Perform supported checks on an existing scoped integration without authorizing it or executing service actions. Report actual evidence rather than blanket health; capability discovery may refresh its cache.",
      requiredPermissions: ["manage"],
      inputSchema: integrationReferenceInputSchema,
      outputSchema: integrationConnectionSchema,
      getResource: (input) => input.reference,
      execute: async (input, context: IntegrationsToolContext) => {
        assertIntegrationReferenceScope(input, context);
        return await requireIntegrationsRuntime(context).verify(input);
      },
    }),
    defineBackofficeRuntimeTool({
      id: "integrations.disconnect",
      namespace: "integrations",
      name: "disconnect",
      description:
        "Disconnect the referenced scoped binding. This does not imply provider-wide credential revocation or deletion of external service data.",
      requiredPermissions: ["manage"],
      inputSchema: integrationReferenceInputSchema,
      outputSchema: z.void(),
      getResource: (input) => input.reference,
      execute: async (input, context: IntegrationsToolContext) => {
        assertIntegrationReferenceScope(input, context);
        await requireIntegrationsRuntime(context).disconnect(input);
      },
    }),
  ],
});
