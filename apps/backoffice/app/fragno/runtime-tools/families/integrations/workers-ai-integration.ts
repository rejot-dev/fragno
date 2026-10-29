import type { IntegrationInspection } from "@fragno-dev/backoffice-api/v0/integrations";
import type { JsonValue } from "@fragno-dev/backoffice-api/v0/shared/json";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { z } from "zod";

import { BackofficeUnavailableError } from "@/backoffice-runtime/kernel";
import { isBackofficeObjectAvailableInContext } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";

import { connectionStateOfInspection } from "./integration-events";
import {
  checkedIntegrationActionDefinition,
  type IntegrationActionImplementation,
  type IntegrationContext,
  type IntegrationImplementation,
} from "./integration-implementation";
import {
  clairicContractDrift,
  clairicInputSchema,
  clairicOutputSchema,
} from "./workers-ai-clairic";

const workersAiConnectionId = "backoffice#workers-ai";
const workersAiConnectionIdentity = {
  connectionId: workersAiConnectionId,
  integrationId: "workers-ai",
  name: "Workers AI",
  authMethod: "none" as const,
};

/**
 * The models Backoffice runs and bills. Cloudflare's published schemas leave values untyped, so
 * each model's contract is written here, and `drift` compares it with Cloudflare's input schema.
 */
const WORKERS_AI_MODELS = (
  [
    {
      id: "@cf/cloudflare/clairic",
      label: "Clairic",
      description:
        "Read text and up to four images into typed fields. Each answer's `type` matches its field's: values come with a best guess and a confidence, estimates and forecasts with a distribution.",
      input: clairicInputSchema,
      output: clairicOutputSchema,
      drift: clairicContractDrift,
    },
  ] satisfies {
    id: string;
    label: string;
    description: string;
    input: z.ZodType<Record<string, JsonValue>>;
    output: z.ZodType<JsonValue>;
    drift: (cloudflareInput: Record<string, unknown>) => string[];
  }[]
).map((model) => ({ ...model, definition: checkedIntegrationActionDefinition(model) }));

const contractCheckIdentity = { id: "models.contract", label: "Compare model contracts" };
const unsupportedReason =
  "Backoffice runs Workers AI on its own Cloudflare account, so there is nothing to set up.";
const unconfiguredReason =
  "Workers AI is not configured on this deployment: it needs the Workers AI binding, AI; ask its operator.";
const unsupportedScopeReason =
  "Workers AI runs in organization, user, project, and system scopes, not in an app workspace.";

/** Null when Workers AI can run here, otherwise why not. */
type UnavailableReason = string | null;

function inspectWorkersAi(unavailable: UnavailableReason): IntegrationInspection {
  return {
    configuration:
      unavailable === null ? { status: "configured" } : { status: "missing", missingFields: [] },
    authorization: { status: "not-required" },
    checks: [
      {
        ...contractCheckIdentity,
        status: "not-checked",
        reason:
          unavailable ??
          "Verify compares each model's contract with the schema Cloudflare publishes.",
      },
    ],
    nextSteps: unavailable === null ? [] : [unavailable],
  };
}

function assertWorkersAiLocalId(localId: string) {
  if (localId !== workersAiConnectionIdentity.integrationId) {
    throw new Error("Workers AI integration connection not found.");
  }
}

/**
 * Projects the platform's Workers AI models as actions. PiManager owns the binding and bills every
 * run to the caller's ledger, so callers bring no credentials.
 */
export function createWorkersAiIntegration({
  runtime,
  nowEpochMs,
}: {
  runtime: Pick<BackofficeRuntimeServices, "objects" | "config">;
  nowEpochMs: () => number;
}): IntegrationImplementation {
  /** PiManager runs and bills Workers AI, so it must exist in the caller's scope. */
  function unavailableReason(context: IntegrationContext): UnavailableReason {
    if (!runtime.config.bindings.piManager || !runtime.config.workersAi) {
      return unconfiguredReason;
    }
    return isBackofficeObjectAvailableInContext("PI_MANAGER", context.execution.scope)
      ? null
      : unsupportedScopeReason;
  }

  function getPiManager(context: IntegrationContext) {
    const unavailable = unavailableReason(context);
    if (unavailable !== null) {
      throw new BackofficeUnavailableError(unavailable);
    }
    return context.kernel.scoped("PI_MANAGER", context.execution.scope, runtime.objects.piManager)
      .commands;
  }

  return {
    connectionIds: [{ kind: "exact", connectionId: workersAiConnectionId }],
    setup: { kind: "unsupported", reason: unsupportedReason },
    reconfigure: { kind: "unsupported", reason: unsupportedReason },
    disconnect: { kind: "unsupported", reason: unsupportedReason },
    async discover(context) {
      const unavailable = unavailableReason(context);
      return [
        {
          id: workersAiConnectionIdentity.integrationId,
          label: workersAiConnectionIdentity.name,
          description: `Models Cloudflare hosts, each run billed to this scope's owner: ${WORKERS_AI_MODELS.map(({ label }) => label).join(", ")}.`,
          connectionCardinality: "singleton",
          availability:
            unavailable === null
              ? { status: "available" }
              : { status: "unavailable", reason: unavailable },
          setupTargets: [],
          automationEvents: [],
        },
      ];
    },
    async list(context, cursor) {
      if (cursor !== null) {
        throw new Error("Workers AI integration listing cursor is invalid.");
      }
      if (unavailableReason(context) !== null) {
        return { connections: [], cursor: null };
      }
      return {
        connections: [
          {
            ...workersAiConnectionIdentity,
            ...inspectWorkersAi(null),
            configuration: { status: "configured" },
          },
        ],
        cursor: null,
      };
    },
    async resolve(context, localId) {
      assertWorkersAiLocalId(localId);
      return {
        identity: workersAiConnectionIdentity,
        async inspect() {
          return inspectWorkersAi(unavailableReason(context));
        },
        async state() {
          return connectionStateOfInspection(inspectWorkersAi(unavailableReason(context)));
        },
        async details() {
          return { kind: "native" };
        },
        async settings() {
          return null;
        },
        async actions() {
          const unavailable = unavailableReason(context);
          if (unavailable !== null) {
            throw new BackofficeUnavailableError(unavailable);
          }
          return WORKERS_AI_MODELS.map(
            ({ id: model, definition, input, output }): IntegrationActionImplementation => ({
              definition: definition(),
              async invoke(value) {
                const parsed = input.safeParse(value);
                if (!parsed.success) {
                  throw new Error(
                    `Workers AI input failed ${model}'s contract: ${z.prettifyError(parsed.error)}`,
                  );
                }
                const { output: result } = await context.kernel.invoke({
                  execution: context.execution,
                  operation: BACKOFFICE_PERMISSION.models.run,
                  resource: { model },
                  execute: () => getPiManager(context).runWorkersAi({ model, input: parsed.data }),
                });
                // Parsing drops properties the contract does not name, so callers get its shape.
                const answer = output.safeParse(result);
                if (!answer.success) {
                  throw new Error(
                    `Workers AI output failed ${model}'s contract: ${z.prettifyError(answer.error)} The model has already run and been billed, so do not retry automatically.`,
                  );
                }
                return answer.data;
              },
            }),
          );
        },
        async verify() {
          const inspection = inspectWorkersAi(unavailableReason(context));
          if (inspection.configuration.status === "missing") {
            return inspection;
          }
          const piManager = getPiManager(context);
          const problems = (
            await Promise.all(
              WORKERS_AI_MODELS.map(async ({ id: model, drift }) => {
                const described = await piManager.describeWorkersAiModel({ model });
                return described.status === "unavailable"
                  ? [described.reason]
                  : drift(described.inputSchema).map((difference) => `${model}: ${difference}`);
              }),
            )
          ).flat();
          return {
            ...inspection,
            checks: [
              {
                ...contractCheckIdentity,
                status: problems.length === 0 ? "passed" : "failed",
                checkedAt: new Date(nowEpochMs()).toISOString(),
                message:
                  problems.length === 0
                    ? `Cloudflare's schemas match Backoffice's contracts: ${WORKERS_AI_MODELS.map(({ id }) => id).join(", ")}.`
                    : problems.join(" "),
              },
            ],
          };
        },
      };
    },
  };
}
