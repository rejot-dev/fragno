import { z } from "zod";

import { backofficeContextScopeSchema } from "@/backoffice-runtime/context";
import { jsonValueSchema } from "@/lib/zod/json-value";

import { isoDateTimeOutputSchema } from "../../output-schemas";

const integrationIdSchema = z
  .string()
  .min(1)
  .describe("Service identity returned by discover; it does not identify an integration mechanism.")
  .meta({ id: "IntegrationId" });
const integrationReferenceSchema = z
  .strictObject({
    id: z
      .string()
      .min(1)
      .describe("Opaque binding handle returned by the runtime, not an adapter ID."),
    scope: backofficeContextScopeSchema.meta({ codemodeType: "BackofficeCodemodeScope" }),
  })
  .meta({ id: "IntegrationReference" });
const integrationJsonSchemaSchema = z
  .union([z.boolean(), z.record(z.string(), z.unknown())])
  .describe(
    "Authoritative JSON Schema supplied by the integration, never inferred from an action ID.",
  )
  .meta({ id: "IntegrationJsonSchema" });

/** Integration discovery reports service availability in the selected scope, not live health. */
export const integrationOverviewSchema = z
  .strictObject({
    id: integrationIdSchema,
    label: z.string(),
    description: z.string(),
    connectionCardinality: z
      .enum(["singleton", "multiple"])
      .describe(
        "Singleton means one active binding or setup per service and owner scope. Repeated connect reuses it without renaming or replacing shared configuration.",
      ),
    availability: z
      .discriminatedUnion("status", [
        z.strictObject({ status: z.literal("available") }),
        z.strictObject({ status: z.literal("unavailable"), reason: z.string() }),
      ])
      .describe(
        "Whether this service can be connected in the selected scope, not live service health.",
      )
      .meta({ id: "IntegrationAvailability" }),
    automationEvents: z
      .array(z.strictObject({ source: z.string(), eventType: z.string() }))
      .describe("Declared event identities do not prove live event delivery."),
  })
  .meta({ id: "IntegrationOverview" });
const integrationConfigurationStatusSchema = z
  .discriminatedUnion("status", [
    z.strictObject({ status: z.literal("missing"), missingFields: z.array(z.string()) }),
    z.strictObject({ status: z.literal("configured") }),
  ])
  .meta({ id: "IntegrationConfigurationStatus" });
const integrationAuthorizationStatusSchema = z
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
const integrationVerificationCheckShape = {
  id: z.string().min(1),
  label: z.string(),
};
const integrationVerificationCheckSchema = z
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
const integrationInspectionSchema = z.strictObject({
  configuration: integrationConfigurationStatusSchema,
  authorization: integrationAuthorizationStatusSchema,
  checks: z
    .array(integrationVerificationCheckSchema)
    .describe(
      "Supported checks retain not-checked states; a saved binding alone proves no live health.",
    ),
  nextSteps: z.array(z.string()),
});

/** Integration connection identity is supplied by the runtime, not by private adapter inspection. */
export const integrationConnectionSchema = integrationInspectionSchema
  .extend({
    reference: integrationReferenceSchema,
    integrationId: integrationIdSchema,
    name: z.string(),
  })
  .meta({ id: "IntegrationConnection" });
const configuredIntegrationSchema = integrationConnectionSchema
  .extend({ configuration: z.strictObject({ status: z.literal("configured") }) })
  .meta({ id: "ConfiguredIntegration" });

const integrationSetupProgressShape = {
  setupId: z
    .string()
    .min(1)
    .describe("Opaque setup attempt handle; it does not grant access or change scope."),
};

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
      reference: integrationReferenceSchema.describe(
        "Setup requirements have been met; not a blanket health claim.",
      ),
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

/** Integration action schemas describe the operation's own result, including asynchronous job handles. */
export const integrationActionSchema = z
  .strictObject({
    id: z.string().min(1).describe("Action identity returned by actions for this binding."),
    label: z.string(),
    description: z.string(),
    inputSchema: integrationJsonSchemaSchema,
    outputSchema: integrationJsonSchemaSchema.describe(
      "Describes the action's own result, including any asynchronous job handle.",
    ),
  })
  .meta({ id: "IntegrationAction" });

/** Integration listing starts with a null cursor and never selects an adapter. */
export const integrationListInputSchema = z.strictObject({
  cursor: z
    .string()
    .nullable()
    .describe("Null starts the scoped listing; use the returned next cursor."),
});

/** Integration list pages include configured bindings, not unconfigured service definitions. */
export const integrationListOutputSchema = z.strictObject({
  integrations: z.array(configuredIntegrationSchema),
  cursor: z
    .string()
    .nullable()
    .describe("Null means all configured integrations in this scope have been listed."),
});

/** Integration references identify an owner but neither grant access nor switch scope. */
export const integrationReferenceInputSchema = z.strictObject({
  reference: integrationReferenceSchema,
});

/** Integration connection requests select a service and name; setup owns mechanism-specific input. */
export const integrationConnectInputSchema = z.strictObject({
  integrationId: integrationIdSchema,
  name: z
    .string()
    .trim()
    .min(1)
    .describe("Name for a new binding; repeated singleton connect retains the existing name."),
});
const integrationSetupResponseSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("input"),
    values: z
      .unknown()
      .nonoptional()
      .describe(
        "Untrusted values validated against the attempt's current input schema before use.",
      ),
  }),
  z.strictObject({
    kind: z
      .literal("check")
      .describe("Check authoritative external state; user confirmation is not proof of consent."),
  }),
]);

/** Integration setup continuation accepts requested input or a check, never an assertion of consent. */
export const integrationContinueSetupInputSchema = z.strictObject({
  setupId: integrationSetupProgressShape.setupId,
  response: integrationSetupResponseSchema,
});

/** Action values are JSON; action-specific validation still precedes service side effects. */
export const integrationExecuteInputSchema = integrationReferenceInputSchema.extend({
  actionId: z.string().min(1),
  input: jsonValueSchema
    .describe(
      "JSON action input, validated against the live action schema before dispatch. Binary inputs use schema-declared byte arrays of integers 0–255, never ArrayBuffer or typed arrays; implementations convert them privately.",
    )
    .meta({ codemodeType: "JsonValue" }),
});

/** Integration discovery metadata has one canonical schema shared by tools and implementations. */
export type IntegrationOverview = z.output<typeof integrationOverviewSchema>;

/** Integration inspection excludes identity and ownership, which the runtime attaches separately. */
export type IntegrationInspection = z.output<typeof integrationInspectionSchema>;

/** Integration setup progress is the public projection; private state stays behind the setup ID. */
export type IntegrationSetupProgress = z.output<typeof integrationSetupProgressSchema>;

/** Integration setup response is untrusted at acquisition and interpreted only by the current attempt. */
export type IntegrationSetupResponse = z.output<typeof integrationSetupResponseSchema>;

/** Integration action metadata contains contracts but no executable handler. */
export type IntegrationAction = z.output<typeof integrationActionSchema>;
