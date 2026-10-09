import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { isoDateTimeOutputSchema } from "./shared/datetime";
import { jsonValueSchema } from "./shared/json";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";

export const integrationVerificationCheckShape = {
  id: z.string().min(1),
  label: z.string(),
};

export const integrationVerificationCheckSchema = z
  .discriminatedUnion("status", [
    z.strictObject({
      ...integrationVerificationCheckShape,
      status: z.literal("not-checked"),
      reason: z.string(),
    }),
    z.strictObject({
      ...integrationVerificationCheckShape,
      status: z.enum(["passed", "failed"]),
      checkedAt: isoDateTimeOutputSchema.describe(
        "Time of the actual check, not configuration storage.",
      ),
      message: z.string(),
    }),
  ])
  .meta({ id: "IntegrationVerificationCheck" });

export const integrationConfigurationStatusSchema = z
  .discriminatedUnion("status", [
    z.strictObject({ status: z.literal("missing"), missingFields: z.array(z.string()) }),
    z.strictObject({ status: z.literal("configured") }),
  ])
  .meta({ id: "IntegrationConfigurationStatus" });

export const integrationAuthorizationStatusSchema = z
  .discriminatedUnion("status", [
    z.strictObject({ status: z.literal("not-required") }),
    z.strictObject({ status: z.literal("not-checked") }),
    z.strictObject({ status: z.literal("missing") }),
    z.strictObject({
      status: z
        .literal("available")
        .describe(
          "Credentials or confirmed consent exist; this does not prove live service access.",
        ),
    }),
    z.strictObject({ status: z.literal("expired") }),
  ])
  .meta({ id: "IntegrationAuthorizationStatus" });

export const integrationSetupSubmissionSchema = z.strictObject({
  kind: z.literal("input"),
  input: jsonValueSchema
    .describe(
      "Direct JSON setup input validated against the source's current requirements. Null is a submitted value, never a check sentinel.",
    )
    .meta({ codemodeType: "JsonValue" }),
});

/** Connection IDs preserve source identity and resolve only within the selected execution scope. */
export const integrationConnectionIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*#[\s\S]+$/, "Integration connection ID must be namespace#local-id.")
  .describe(
    "Deterministic scoped address such as backoffice#reson8, not a credential or a separately revocable binding. The suffix preserves the source's identity.",
  )
  .meta({ id: "IntegrationConnectionId" });

export const integrationSetupProgressShape = {
  connectionId: integrationConnectionIdSchema,
};

export const integrationSetupCheckSchema = z.strictObject({
  kind: z
    .literal("check")
    .describe("Read authoritative setup state; user confirmation is not proof of consent."),
});

export const integrationJsonSchemaSchema = z
  .union([z.boolean(), z.record(z.string(), z.unknown())])
  .describe(
    "Authoritative JSON Schema supplied by the integration, never inferred from an action ID.",
  )
  .meta({ id: "IntegrationJsonSchema" });

export const integrationInspectionSchema = z.strictObject({
  configuration: integrationConfigurationStatusSchema,
  authorization: integrationAuthorizationStatusSchema,
  checks: z
    .array(integrationVerificationCheckSchema)
    .describe(
      "Supported checks distinguish missing evidence from actual timestamped results; saved configuration alone proves no live health.",
    ),
  nextSteps: z.array(z.string()),
});

/** Integration inspection excludes connection identity, which the runtime attaches separately. */
export type IntegrationInspection = z.output<typeof integrationInspectionSchema>;

export const integrationIdSchema = z
  .string()
  .min(1)
  .describe("Service identity returned by discover; it does not identify an integration mechanism.")
  .meta({ id: "IntegrationId" });

export const integrationConnectionSetupTargetSchema = z
  .strictObject({ kind: z.literal("connection"), connectionId: integrationConnectionIdSchema })
  .meta({ id: "IntegrationConnectionSetupTarget" });

/** Public connection records describe source-owned configuration, never a facade-owned binding. */
export type IntegrationConnection = z.output<typeof integrationConnectionSchema>;

/** Integration connection identity is supplied by the runtime, not by private adapter inspection. */
export const integrationConnectionSchema = integrationInspectionSchema
  .extend({
    connectionId: integrationConnectionIdSchema,
    integrationId: integrationIdSchema,
    name: z.string(),
  })
  .meta({ id: "IntegrationConnection" });

export const configuredIntegrationSchema = integrationConnectionSchema
  .extend({ configuration: z.strictObject({ status: z.literal("configured") }) })
  .meta({ id: "ConfiguredIntegrationConnection" });

/** Public integration setup progress never exposes private continuation state or binding data. */
export const integrationSetupProgressSchema = z
  .discriminatedUnion("status", [
    z.strictObject({
      ...integrationSetupProgressShape,
      status: z.literal("needs-input"),
      instructions: z.string(),
      inputSchema: integrationJsonSchemaSchema,
      secretFields: z
        .array(z.string())
        .describe("Secret property names for input controls, never secret values."),
    }),
    z.strictObject({
      ...integrationSetupProgressShape,
      status: z.literal("needs-authorization"),
      instructions: z.string(),
      authorizationUrl: z.url(),
    }),
    z.strictObject({
      ...integrationSetupProgressShape,
      status: z.literal("pending"),
      message: z.string(),
    }),
    z.strictObject({
      ...integrationSetupProgressShape,
      status: z.literal("ready"),
    }),
    z.strictObject({
      ...integrationSetupProgressShape,
      status: z.literal("blocked"),
      reason: z.string(),
    }),
    z.strictObject({
      ...integrationSetupProgressShape,
      status: z.literal("expired"),
      reason: z.string(),
    }),
  ])
  .meta({ id: "IntegrationSetupProgress" });

/** Integration setup progress describes current requirements without exposing private continuation data. */
export type IntegrationSetupProgress = z.output<typeof integrationSetupProgressSchema>;

/** Connection operations select an address, never a caller-supplied owner scope. */
export const integrationConnectionInputSchema = z.strictObject({
  connectionId: integrationConnectionIdSchema,
});

/** Named setup distinguishes checking source-owned state from submitting any JSON value, including null. */
export const integrationSetupInputSchema = z.discriminatedUnion("kind", [
  integrationSetupCheckSchema.extend(integrationConnectionInputSchema.shape),
  integrationSetupSubmissionSchema.extend(integrationConnectionInputSchema.shape),
]);

/** Setup requests select a scoped address and carry one explicit operation, without private continuation data. */
export type IntegrationSetupInput = z.output<typeof integrationSetupInputSchema>;

/** Integration discovery reports service availability in the selected scope, not live health. */
export const integrationOverviewSchema = z
  .strictObject({
    id: integrationIdSchema,
    label: z.string(),
    description: z.string(),
    connectionCardinality: z
      .enum(["singleton", "multiple"])
      .describe(
        "Singleton means one scoped configuration; multiple means separately selectable connections. Credentials remain in their existing service-owned stores.",
      ),
    availability: z
      .discriminatedUnion("status", [
        z.strictObject({ status: z.literal("available") }),
        z.strictObject({ status: z.literal("unavailable"), reason: z.string() }),
      ])
      .describe(
        "Whether this service's configuration store is available in the selected scope, not whether credentials are present or live service access works.",
      )
      .meta({ id: "IntegrationAvailability" }),
    setupTargets: z
      .array(integrationConnectionSetupTargetSchema)
      .describe(
        "Known named setup targets, including unconfigured fixed slots; never invented account or attempt IDs.",
      ),
    automationEvents: z
      .array(z.strictObject({ source: z.string(), eventType: z.string() }))
      .describe("Declared event identities do not prove live event delivery."),
  })
  .meta({ id: "IntegrationOverview" });

/** Integration discovery metadata has one canonical schema shared by tools and implementations. */
export type IntegrationOverview = z.output<typeof integrationOverviewSchema>;

/** Integration list pages project existing configured connections, not independent binding records. */
export const integrationListOutputSchema = z.strictObject({
  connections: z.array(configuredIntegrationSchema),
  cursor: z
    .string()
    .nullable()
    .describe("Null means all configured integrations in this scope have been listed."),
});

/** Connection pages retain source pagination without allocating new connection identities. */
export type IntegrationConnectionPage = z.output<typeof integrationListOutputSchema>;

/** Integration listing starts with a null cursor and never selects an adapter. */
export const integrationListInputSchema = z.strictObject({
  cursor: z
    .string()
    .nullable()
    .describe("Null starts the scoped listing; use the returned next cursor."),
});

/** Action values are JSON; action-specific validation still precedes service side effects. */
export const integrationExecuteInputSchema = integrationConnectionInputSchema.extend({
  actionId: z.string().min(1),
  input: jsonValueSchema
    .describe(
      "JSON action input, validated against the live action schema before dispatch. Binary inputs use schema-declared byte arrays of integers 0–255, never ArrayBuffer or typed arrays; implementations convert them privately.",
    )
    .meta({ codemodeType: "JsonValue" }),
});

/** Integration action schemas describe the operation's own result, including asynchronous job handles. */
export const integrationActionSchema = z
  .strictObject({
    id: z.string().min(1).describe("Action identity returned by actions for this connection."),
    label: z.string(),
    description: z.string(),
    inputSchema: integrationJsonSchemaSchema,
    outputSchema: integrationJsonSchemaSchema.describe(
      "Describes the action's own result, including any asynchronous job handle.",
    ),
  })
  .meta({ id: "IntegrationAction" });

/** Integration action metadata contains contracts but no executable handler. */
export type IntegrationAction = z.output<typeof integrationActionSchema>;

export const integrationsOperations = {
  "integrations.discover": {
    description:
      "Discover available services and unconfigured services in the selected scope. Service availability does not prove live health.",
    permissions: [BACKOFFICE_PERMISSION.integrations.read],
    input: z.void(),
    output: z.array(integrationOverviewSchema),
  },
  "integrations.list": {
    description:
      "List existing configured connections in the selected scope, one cursor page at a time. Deterministic IDs reuse source-owned identities; configuration does not imply live access.",
    permissions: [BACKOFFICE_PERMISSION.integrations.read],
    input: integrationListInputSchema,
    output: integrationListOutputSchema,
  },
  "integrations.get": {
    description:
      "Inspect source-owned connection configuration and available evidence without performing a live health check. The connection ID resolves only within the selected scope.",
    permissions: [BACKOFFICE_PERMISSION.integrations.read],
    input: integrationConnectionInputSchema,
    output: integrationConnectionSchema,
  },
  "integrations.setup": {
    description:
      "Read current requirements or submit input for a deterministic connection address. Setup is source-owned; this operation retains no attempt state or independent binding. Already configured Reson8 reuses its key without replacing it.",
    permissions: [BACKOFFICE_PERMISSION.integrations.manage],
    input: integrationSetupInputSchema,
    output: integrationSetupProgressSchema,
  },
  "integrations.actions": {
    description:
      "Discover the selected connection's supported actions and authoritative input/output contracts without executing them. Never infer schemas from action IDs.",
    permissions: [BACKOFFICE_PERMISSION.integrations.read],
    input: integrationConnectionInputSchema,
    output: z.array(integrationActionSchema),
  },
  "integrations.execute": {
    description:
      "Execute an explicit connection action with JSON input/output, validated against its live contracts and service permissions. Binary inputs are schema-declared byte arrays; results retain the action's domain and asynchronous semantics.",
    permissions: [BACKOFFICE_PERMISSION.integrations.execute],
    input: integrationExecuteInputSchema,
    output: jsonValueSchema.meta({ codemodeType: "JsonValue" }),
  },
  "integrations.verify": {
    description:
      "Perform explicit supported live checks without authorizing the connection or executing service actions. Return timestamped evidence, not blanket health or retained verification state.",
    permissions: [BACKOFFICE_PERMISSION.integrations.manage],
    input: integrationConnectionInputSchema,
    output: integrationConnectionSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
