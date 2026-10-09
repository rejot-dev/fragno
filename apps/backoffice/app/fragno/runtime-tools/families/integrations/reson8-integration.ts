import type {
  IntegrationInspection,
  IntegrationSetupProgress,
} from "@fragno-dev/backoffice-api/v0/integrations";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { createRouteCaller } from "@fragno-dev/core/api";
import { z } from "zod";

import {
  reson8PrerecordedTranscriptionSchema,
  type Reson8PrerecordedQuery,
} from "@fragno-dev/reson8-fragment";

import { authorizedBackofficeObjectHttp } from "@/backoffice-runtime/authorized-object-http";
import { BackofficeUnavailableError } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { Reson8Fragment } from "@/fragno/reson8";

import {
  isSuccessStatus,
  throwOnBackofficeRouteAuthorizationError,
  throwOnRouteRuntimeError,
} from "../../runtime-errors";
import type { IntegrationContext, IntegrationImplementation } from "./integration-implementation";

const reson8ConnectionIdentity = {
  connectionId: "backoffice#reson8",
  integrationId: "reson8",
  name: "Reson8",
};
const reson8SetupInputSchema = z.strictObject({
  apiKey: z
    .string()
    .trim()
    .min(1)
    .describe("Secret API key stored in this organization's shared Reson8 configuration."),
});
const reson8TranscriptionInputSchema = z.strictObject({
  audio: z.strictObject({ bytes: z.array(z.number().int().min(0).max(255)) }),
  query: z
    .strictObject({
      encoding: z.enum(["auto", "pcm_s16le"]).nullable(),
      sample_rate: z.number().int().positive().nullable(),
      channels: z.number().int().positive().nullable(),
      custom_model_id: z.string().trim().min(1).nullable(),
      include_timestamps: z.boolean().nullable(),
      include_words: z.boolean().nullable(),
      include_confidence: z.boolean().nullable(),
    } satisfies {
      [TKey in keyof Required<Reson8PrerecordedQuery>]: z.ZodType<
        Required<Reson8PrerecordedQuery>[TKey] | null
      >;
    })
    .nullable()
    .describe(
      "Null uses service defaults. Null query fields are omitted from the provider request.",
    ),
});
const reson8TranscriptionActionDefinition = {
  id: "prerecorded.transcribe",
  label: "Transcribe prerecorded audio",
  description: "Transcribe audio bytes through the organization's current Reson8 configuration.",
  inputSchema: z.toJSONSchema(reson8TranscriptionInputSchema, { io: "input" }),
  outputSchema: z.toJSONSchema(reson8PrerecordedTranscriptionSchema, { io: "output" }),
};
const reson8AccessCheckIdentity = { id: "custom-models.read", label: "Read custom models" };

function inspectReson8Configuration(configured: boolean): IntegrationInspection {
  return {
    configuration: configured
      ? { status: "configured" }
      : { status: "missing", missingFields: ["apiKey"] },
    authorization: { status: configured ? "available" : "missing" },
    checks: [
      {
        ...reson8AccessCheckIdentity,
        status: "not-checked",
        reason: configured
          ? "No retained live service check is available."
          : "Configure the Reson8 API key before checking service access.",
      },
    ],
    nextSteps: configured
      ? []
      : ["Provide an API key for this organization's Reson8 configuration."],
  };
}

function describeReson8Setup(configured: boolean): IntegrationSetupProgress {
  return configured
    ? { status: "ready", connectionId: reson8ConnectionIdentity.connectionId }
    : {
        status: "needs-input",
        connectionId: reson8ConnectionIdentity.connectionId,
        instructions:
          "Provide the Reson8 API key for this organization. The key stays in its existing configuration store.",
        inputSchema: z.toJSONSchema(reson8SetupInputSchema, { io: "input" }),
        secretFields: ["apiKey"],
      };
}

function assertReson8LocalId(localId: string) {
  if (localId !== reson8ConnectionIdentity.integrationId) {
    throw new Error("Reson8 integration connection not found.");
  }
}

/** Projects the existing organization configuration slot without owning credentials or setup attempts. */
export function createReson8Integration({
  runtime,
  nowEpochMs,
}: {
  runtime: Pick<BackofficeRuntimeServices, "objects" | "config">;
  nowEpochMs: () => number;
}): IntegrationImplementation {
  function getReson8Object(context: IntegrationContext) {
    if (context.execution.scope.kind !== "org") {
      throw new BackofficeUnavailableError("Reson8 integration requires an organization scope.");
    }
    if (!runtime.config.bindings.reson8) {
      throw new BackofficeUnavailableError("Reson8 integration object binding is unavailable.");
    }
    return context.kernel.scoped("RESON8", context.execution.scope, runtime.objects.reson8);
  }

  function createReson8Caller(context: IntegrationContext) {
    const object = getReson8Object(context);
    const transport = authorizedBackofficeObjectHttp(object.http, context.execution);
    return createRouteCaller<Reson8Fragment>({
      baseUrl: "https://reson8.do",
      mountRoute: "/api/reson8",
      fetch: transport.fetch.bind(transport),
    });
  }

  async function readConfiguration(context: IntegrationContext) {
    const object = getReson8Object(context);
    return await context.kernel.invoke({
      execution: context.execution,
      operation: BACKOFFICE_PERMISSION.connections.read,
      resource: { capabilityId: "reson8" },
      execute: () => object.commands.getAdminConfig(),
    });
  }

  return {
    connectionIds: [{ kind: "exact", connectionId: reson8ConnectionIdentity.connectionId }],
    setup: {
      kind: "supported",
      async run(context, { localId, operation }) {
        assertReson8LocalId(localId);
        if (context.execution.scope.kind !== "org" || !runtime.config.bindings.reson8) {
          return {
            status: "blocked",
            connectionId: reson8ConnectionIdentity.connectionId,
            reason: "Reson8 requires an available organization-owned configuration store.",
          };
        }
        const configuration = await readConfiguration(context);
        // Setup is reconstructed from current configuration, not an earlier attempt or caller claim.
        if (configuration.configured || operation.kind === "check") {
          return describeReson8Setup(configuration.configured);
        }
        const input = reson8SetupInputSchema.parse(operation.input);
        const scope = context.execution.scope;
        const object = getReson8Object(context);
        const configured = await context.kernel.invoke({
          execution: context.execution,
          operation: BACKOFFICE_PERMISSION.connections.manage,
          resource: { capabilityId: "reson8" },
          execute: () => object.commands.setAdminConfig(input, scope.orgId),
        });
        return describeReson8Setup(configured.configured);
      },
    },
    async discover(context) {
      return [
        {
          id: reson8ConnectionIdentity.integrationId,
          label: reson8ConnectionIdentity.name,
          description: "Speech transcription using the organization's Reson8 configuration.",
          connectionCardinality: "singleton",
          availability:
            context.execution.scope.kind !== "org"
              ? { status: "unavailable", reason: "Reson8 connections are organization-owned." }
              : runtime.config.bindings.reson8
                ? { status: "available" }
                : { status: "unavailable", reason: "The Reson8 object binding is unavailable." },
          setupTargets: [
            { kind: "connection", connectionId: reson8ConnectionIdentity.connectionId },
          ],
          automationEvents: [{ source: "reson8", eventType: "capability.configured" }],
        },
      ];
    },
    async list(context, cursor) {
      if (cursor !== null) {
        throw new Error("Reson8 integration listing cursor is invalid.");
      }
      if (context.execution.scope.kind !== "org" || !runtime.config.bindings.reson8) {
        return { connections: [], cursor: null };
      }
      const configuration = await readConfiguration(context);
      if (!configuration.configured) {
        return { connections: [], cursor: null };
      }
      return {
        connections: [
          {
            ...reson8ConnectionIdentity,
            ...inspectReson8Configuration(true),
            configuration: { status: "configured" },
          },
        ],
        cursor: null,
      };
    },
    async resolve(context, localId) {
      assertReson8LocalId(localId);
      getReson8Object(context);
      return {
        identity: reson8ConnectionIdentity,
        async inspect() {
          return inspectReson8Configuration((await readConfiguration(context)).configured);
        },
        async actions() {
          return [
            {
              definition: reson8TranscriptionActionDefinition,
              async invoke(input) {
                const parsed = reson8TranscriptionInputSchema.parse(input);
                const callRoute = createReson8Caller(context);
                const query: Record<string, string> = {};
                for (const [key, value] of Object.entries(parsed.query ?? {})) {
                  if (value !== null) {
                    query[key] = String(value);
                  }
                }
                return await context.kernel.invoke({
                  execution: context.execution,
                  operation: BACKOFFICE_PERMISSION.reson8.use,
                  resource: { actionId: "prerecorded.transcribe" },
                  execute: async () => {
                    const response = await callRoute("POST", "/speech-to-text/prerecorded", {
                      body: new Uint8Array(parsed.audio.bytes),
                      query,
                      headers: { "content-type": "application/octet-stream" },
                    });
                    if (response.type === "json" && isSuccessStatus(response.status)) {
                      return reson8PrerecordedTranscriptionSchema.parse(response.data);
                    }
                    return throwOnRouteRuntimeError(response, {
                      runtimeLabel: "Reson8 fragment",
                      label: "Reson8 integration prerecorded transcription",
                      notConfiguredMessage: "Reson8 is not configured for this organization.",
                    });
                  },
                });
              },
            },
          ];
        },
        async verify() {
          const inspection = inspectReson8Configuration(
            (await readConfiguration(context)).configured,
          );
          if (inspection.configuration.status === "missing") {
            return inspection;
          }
          const callRoute = createReson8Caller(context);
          const response = await context.kernel.invoke({
            execution: context.execution,
            operation: BACKOFFICE_PERMISSION.reson8.use,
            resource: { checkId: "custom-models.read" },
            execute: () => callRoute("GET", "/custom-model"),
          });
          // A receiving-object denial is an execution failure, not evidence about provider health.
          throwOnBackofficeRouteAuthorizationError(response);
          const passed = response.type === "json" && isSuccessStatus(response.status);
          return {
            ...inspection,
            checks: [
              {
                ...reson8AccessCheckIdentity,
                status: passed ? "passed" : "failed",
                checkedAt: new Date(nowEpochMs()).toISOString(),
                message: passed
                  ? "Reson8 accepted a custom-model listing request. Transcription has not been tested."
                  : `Reson8 custom-model listing failed (HTTP ${response.status}).`,
              },
            ],
            nextSteps: passed
              ? []
              : response.status === 401
                ? [
                    "Replace the rejected Reson8 API key through the organization's configuration controls.",
                  ]
                : ["Check Reson8 service availability and retry verification."],
          };
        },
      };
    },
  };
}
