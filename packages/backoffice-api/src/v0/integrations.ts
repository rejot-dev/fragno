import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { isoDateTimeOutputSchema } from "./shared/datetime";
import { jsonValueSchema } from "./shared/json";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";

export const integrationVerificationCheckShape = {
  id: z.lazy(() => z.string().min(1)),
  label: z.lazy(() => z.string()),
};

export const integrationVerificationCheckSchema = z
  .lazy(() =>
    z.discriminatedUnion("status", [
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
    ]),
  )
  .meta({ id: "IntegrationVerificationCheck" });

export const integrationConfigurationStatusSchema = z
  .lazy(() =>
    z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("missing"), missingFields: z.array(z.string()) }),
      z.strictObject({ status: z.literal("configured") }),
    ]),
  )
  .meta({ id: "IntegrationConfigurationStatus" });

export const integrationAuthorizationStatusSchema = z
  .lazy(() =>
    z.discriminatedUnion("status", [
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
    ]),
  )
  .meta({ id: "IntegrationAuthorizationStatus" });

export const integrationSetupSubmissionSchema = z.lazy(() =>
  z.strictObject({
    kind: z.literal("input"),
    input: jsonValueSchema
      .describe(
        "Direct JSON setup input validated against the source's current requirements. Null is a submitted value, never a check sentinel.",
      )
      .meta({ codemodeType: "JsonValue" }),
  }),
);

/** Connection IDs preserve source identity and resolve only within the selected execution scope. */
export const integrationConnectionIdSchema = z
  .lazy(() =>
    z
      .string()
      .regex(/^[a-z][a-z0-9-]*#[\s\S]+$/, "Integration connection ID must be namespace#local-id.")
      .describe(
        "Deterministic scoped address such as backoffice#telegram, not a credential or a separately revocable binding. The suffix preserves the source's identity.",
      ),
  )
  .meta({ id: "IntegrationConnectionId" });

export const integrationSetupProgressShape = {
  connectionId: integrationConnectionIdSchema,
};

export const integrationSetupCheckSchema = z.lazy(() =>
  z.strictObject({
    kind: z
      .literal("check")
      .describe("Read authoritative setup state; user confirmation is not proof of consent."),
  }),
);

export const integrationJsonSchemaSchema = z
  .lazy(() =>
    z
      .union([z.boolean(), z.record(z.string(), z.unknown())])
      .describe(
        "Authoritative JSON Schema supplied by the integration, never inferred from an action ID.",
      ),
  )
  .meta({ id: "IntegrationJsonSchema" });

export const integrationInspectionSchema = z.lazy(() =>
  z.strictObject({
    configuration: integrationConfigurationStatusSchema,
    authorization: integrationAuthorizationStatusSchema,
    checks: z
      .array(integrationVerificationCheckSchema)
      .describe(
        "Supported checks distinguish missing evidence from actual timestamped results; saved configuration alone proves no live health.",
      ),
    nextSteps: z.array(z.string()),
  }),
);

/** Integration inspection excludes connection identity, which the runtime attaches separately. */
export type IntegrationInspection = z.output<typeof integrationInspectionSchema>;

export const integrationIdSchema = z
  .lazy(() =>
    z
      .string()
      .min(1)
      .describe(
        "Service identity returned by discover; it does not identify an integration mechanism.",
      ),
  )
  .meta({ id: "IntegrationId" });

export const integrationConnectionSetupTargetSchema = z
  .lazy(() =>
    z.strictObject({ kind: z.literal("connection"), connectionId: integrationConnectionIdSchema }),
  )
  .meta({ id: "IntegrationConnectionSetupTarget" });

export const integrationAuthMethodSchema = z
  .lazy(() =>
    z
      .enum([
        "none",
        "api-key",
        "bearer",
        "basic",
        "client-credentials",
        "oauth",
        "signature",
        "app-installation",
      ])
      .describe(
        "How the connection authenticates to its provider; for inbound webhooks, how deliveries authenticate. Signature means an HMAC-signed body.",
      ),
  )
  .meta({ id: "IntegrationAuthMethod" });

/** One vocabulary for every source's own auth configuration. */
export type IntegrationAuthMethod = z.output<typeof integrationAuthMethodSchema>;

/** Public connection records describe source-owned configuration, never a facade-owned binding. */
export type IntegrationConnection = z.output<typeof integrationConnectionSchema>;

/** Integration connection identity is supplied by the runtime, not by private adapter inspection. */
export const integrationConnectionSchema = z
  .lazy(() =>
    integrationInspectionSchema._zod.innerType.extend({
      connectionId: integrationConnectionIdSchema,
      integrationId: integrationIdSchema,
      name: z.string(),
      authMethod: integrationAuthMethodSchema
        .nullable()
        .describe(
          "Null while nothing stored at the address chooses a method, such as before API setup.",
        ),
    }),
  )
  .meta({ id: "IntegrationConnection" });

export const integrationConnectionSettingsSchema = z
  .lazy(() => z.record(z.string(), jsonValueSchema).nullable())
  .meta({ id: "IntegrationConnectionSettings" });

/** Source-owned settings a replacement can start from; they never contain secrets. */
export type IntegrationConnectionSettings = z.output<typeof integrationConnectionSettingsSchema>;

export const inspectedIntegrationConnectionSchema = z
  .lazy(() =>
    integrationConnectionSchema._zod.innerType.extend({
      settings: integrationConnectionSettingsSchema.describe(
        "Stored values that are not secret, shaped like this connection's reconfigure input. Start a replacement from them, change what was asked, and supply secrets and omitted fields again. Null when the source takes no replacement or nothing is stored.",
      ),
    }),
  )
  .meta({ id: "InspectedIntegrationConnection" });

export const configuredIntegrationSchema = z
  .lazy(() =>
    integrationConnectionSchema._zod.innerType.extend({
      configuration: z.strictObject({ status: z.literal("configured") }),
    }),
  )
  .meta({ id: "ConfiguredIntegrationConnection" });

/** Public integration setup progress never exposes private continuation state or binding data. */
export const integrationSetupProgressSchema = z
  .lazy(() =>
    z.discriminatedUnion("status", [
      z.strictObject({
        ...integrationSetupProgressShape,
        status: z.literal("needs-input"),
        instructions: z.string(),
        inputSchema: integrationJsonSchemaSchema,
        secretFields: z
          .array(z.string())
          .describe(
            "Secret property names for input controls, as dot-separated paths when nested; never secret values.",
          ),
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
    ]),
  )
  .meta({ id: "IntegrationSetupProgress" });

/** Integration setup progress describes current requirements without exposing private continuation data. */
export type IntegrationSetupProgress = z.output<typeof integrationSetupProgressSchema>;

/** Connection operations select an address, never a caller-supplied owner scope. */
export const integrationConnectionInputSchema = z.lazy(() =>
  z.strictObject({
    connectionId: integrationConnectionIdSchema,
  }),
);

/** Named setup distinguishes checking source-owned state from submitting any JSON value, including null. */
export const integrationSetupInputSchema = z.lazy(() =>
  z.discriminatedUnion("kind", [
    integrationSetupCheckSchema._zod.innerType.extend(
      integrationConnectionInputSchema._zod.innerType.shape,
    ),
    integrationSetupSubmissionSchema._zod.innerType.extend(
      integrationConnectionInputSchema._zod.innerType.shape,
    ),
  ]),
);

/** Setup requests select a scoped address and carry one explicit operation, without private continuation data. */
export type IntegrationSetupInput = z.output<typeof integrationSetupInputSchema>;

/** Disconnecting repeats the address, so removal is never a side effect of an edited command. */
export const integrationDisconnectInputSchema = z.lazy(() =>
  integrationConnectionInputSchema._zod.innerType
    .extend({
      confirm: integrationConnectionIdSchema.describe(
        "Repeat connectionId to confirm removing its source-owned configuration and credentials.",
      ),
    })
    .refine((input) => input.confirm === input.connectionId, {
      message: "Integration disconnect confirmation must repeat the connection ID.",
      path: ["confirm"],
    }),
);

/** Disconnect results report source state; the address stays valid for a later setup. */
export const integrationDisconnectResultSchema = z
  .lazy(() =>
    z.strictObject({
      connectionId: integrationConnectionIdSchema,
      status: z
        .enum(["disconnected", "not-configured"])
        .describe("Not-configured means nothing was stored at this address in the selected scope."),
    }),
  )
  .meta({ id: "IntegrationDisconnectResult" });

/** Disconnect results never retain a removed connection's configuration. */
export type IntegrationDisconnectResult = z.output<typeof integrationDisconnectResultSchema>;

export const integrationConnectionEventsBackfillResultSchema = z
  .lazy(() =>
    z.strictObject({
      connections: z.array(
        z.strictObject({
          connectionId: integrationConnectionIdSchema,
          service: integrationIdSchema,
          state: z.enum(["ready", "unavailable", "disconnected"]),
        }),
      ),
    }),
  )
  .meta({ id: "IntegrationConnectionEventsBackfillResult" });

/** Integration discovery reports service availability in the selected scope, not live health. */
export const integrationOverviewSchema = z
  .lazy(() =>
    z.strictObject({
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
        .describe(
          "Source-specific activity events; declared identities do not prove live event delivery. Connection state changes arrive for every service as source integrations, keyed by subject.connectionId.",
        ),
    }),
  )
  .meta({ id: "IntegrationOverview" });

/** Integration discovery metadata has one canonical schema shared by tools and implementations. */
export type IntegrationOverview = z.output<typeof integrationOverviewSchema>;

/** Integration list pages project existing configured connections, not independent binding records. */
export const integrationListOutputSchema = z.lazy(() =>
  z.strictObject({
    connections: z.array(configuredIntegrationSchema),
    unavailableSources: z
      .array(
        z.strictObject({
          source: z
            .string()
            .describe(
              "Addresses the source owns: `namespace#` for a whole namespace, or one exact connection ID.",
            ),
          reason: z.string(),
        }),
      )
      .describe(
        "Sources that failed to list in this page. Their connections are missing from the listing, not removed; list again later.",
      ),
    cursor: z
      .string()
      .nullable()
      .describe("Null means all configured integrations in this scope have been listed."),
  }),
);

/** Connection pages retain source pagination without allocating new connection identities. */
export type IntegrationConnectionPage = z.output<typeof integrationListOutputSchema>;

/** Integration listing starts with a null cursor and never selects an adapter. */
export const integrationListInputSchema = z.lazy(() =>
  z.strictObject({
    cursor: z
      .string()
      .nullable()
      .describe("Null starts the scoped listing; use the returned next cursor."),
  }),
);

/** Action values are JSON; action-specific validation still precedes service side effects. */
export const integrationExecuteInputSchema = z.lazy(() =>
  integrationConnectionInputSchema._zod.innerType.extend({
    actionId: z.string().min(1),
    input: jsonValueSchema
      .describe(
        "JSON action input, validated against the live action schema before dispatch. Binary inputs use schema-declared byte arrays of integers 0–255, never ArrayBuffer or typed arrays; implementations convert them privately.",
      )
      .meta({ codemodeType: "JsonValue" }),
    unchecked: z
      .boolean()
      .default(false)
      .describe(
        "Required to run an action whose validation is unchecked: its input and output skip validation and the service alone rejects bad input. Checked actions validate regardless.",
      ),
  }),
);

/**
 * Whether execution validates an action against its schemas. Unchecked actions publish contracts
 * that cannot be validated faithfully, so callers must opt in to running them.
 */
export const integrationActionValidationSchema = z
  .lazy(() =>
    z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("checked") }),
      z.strictObject({
        kind: z.literal("unchecked"),
        reason: z.string().describe("Why the published schemas cannot be validated."),
      }),
    ]),
  )
  .meta({ id: "IntegrationActionValidation" });

/** Integration action schemas describe the operation's own result, including asynchronous job handles. */
export const integrationActionSchema = z
  .lazy(() =>
    z.strictObject({
      id: z.string().min(1).describe("Action identity returned by actions for this connection."),
      label: z.string(),
      description: z.string(),
      validation: integrationActionValidationSchema,
      inputSchema: integrationJsonSchemaSchema,
      outputSchema: integrationJsonSchemaSchema.describe(
        "Describes the action's own result, including any asynchronous job handle.",
      ),
    }),
  )
  .meta({ id: "IntegrationAction" });

/** Integration action metadata contains contracts but no executable handler. */
export type IntegrationAction = z.output<typeof integrationActionSchema>;

export const integrationGenerateClientInputSchema = z.lazy(() =>
  integrationConnectionInputSchema._zod.innerType.extend({
    out: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Absolute path of the .js module to write under /workspace. Only a module this operation generated is replaced.",
      ),
  }),
);

/** Generated clients are snapshots of the connection's action contracts. */
export const integrationClientSchema = z
  .lazy(() =>
    z.strictObject({
      path: z.string(),
      exports: z.array(
        z.strictObject({
          name: z.string().describe("Exported function name."),
          actionId: z.string().describe("Action the function executes."),
        }),
      ),
    }),
  )
  .meta({ id: "IntegrationClient" });

export const integrationsOperations = {
  "integrations.discover": {
    description:
      "Discover available services and unconfigured services in the selected scope. Service availability does not prove live health.",
    permissions: [BACKOFFICE_PERMISSION.integrations.read],
    input: z.void(),
    output: z.lazy(() => z.array(integrationOverviewSchema)),
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
      "Inspect source-owned connection configuration, its stored non-secret settings, and available evidence without performing a live health check. The connection ID resolves only within the selected scope.",
    permissions: [BACKOFFICE_PERMISSION.integrations.read],
    input: integrationConnectionInputSchema,
    output: inspectedIntegrationConnectionSchema,
  },
  "integrations.setup": {
    description:
      "Read current requirements or submit input for a deterministic connection address. Setup is source-owned; this operation retains no attempt state or independent binding. Ready connections keep their configuration and credentials; reconfigure replaces them. Input may move setup to another address the same source derives from it, such as a new connection name; the progress names the address it describes.",
    permissions: [BACKOFFICE_PERMISSION.integrations.manage],
    input: integrationSetupInputSchema,
    output: integrationSetupProgressSchema,
  },
  "integrations.reconfigure": {
    description:
      "Read replacement requirements or submit replacement configuration or credentials for an existing connection. Build the replacement from integrations.get settings so unchanged values carry over. Submission replaces source-owned state; continue with setup checks until ready. A missing connection needs setup.",
    permissions: [BACKOFFICE_PERMISSION.integrations.manage],
    input: integrationSetupInputSchema,
    output: integrationSetupProgressSchema,
  },
  "integrations.disconnect": {
    description:
      "Remove a connection's source-owned configuration and credentials in the selected scope. The address stays valid for a later setup. Requires confirm to repeat the connection ID.",
    permissions: [BACKOFFICE_PERMISSION.integrations.manage],
    input: integrationDisconnectInputSchema,
    output: integrationDisconnectResultSchema,
  },
  "integrations.backfillConnectionEvents": {
    description:
      "Record every configured connection's current state in the selected scope as an integrations.connection.ready or connection.unavailable event, for connections that existed before those events were recorded. Routes on those events run for each new event. Events carry each connection's name and auth method. A rerun records a connection again only when its state, name, or auth method differs from every earlier backfill of it, so a rerun adds names to connections recorded before events carried them. A connection last recorded ready or unavailable at an address no source owns anymore, because its integration was removed, is recorded as connection.disconnected, once.",
    permissions: [BACKOFFICE_PERMISSION.integrations.manage],
    input: z.void(),
    output: integrationConnectionEventsBackfillResultSchema,
  },
  "integrations.actions": {
    description:
      "Discover the selected connection's supported actions and authoritative input/output contracts without executing them. Never infer schemas from action IDs.",
    permissions: [BACKOFFICE_PERMISSION.integrations.read],
    input: integrationConnectionInputSchema,
    output: z.lazy(() => z.array(integrationActionSchema)),
  },
  "integrations.execute": {
    description:
      "Execute an explicit connection action with JSON input/output, validated against its live contracts and service permissions. Unchecked actions run only with unchecked: true. Binary inputs are schema-declared byte arrays; results retain the action's domain and asynchronous semantics.",
    permissions: [BACKOFFICE_PERMISSION.integrations.execute],
    input: integrationExecuteInputSchema,
    output: jsonValueSchema.meta({ codemodeType: "JsonValue" }),
  },
  "integrations.generateClient": {
    description:
      "Write a JavaScript module with one typed async function per action of the selected connection, for codemode and saved modules to import. Each function calls integrations.execute; its JSDoc types snapshot the action contracts, so regenerate after the connection's actions change.",
    permissions: [BACKOFFICE_PERMISSION.integrations.read, BACKOFFICE_PERMISSION.upload.modify],
    input: integrationGenerateClientInputSchema,
    output: integrationClientSchema,
  },
  "integrations.verify": {
    description:
      "Perform explicit supported live checks without authorizing the connection or executing service actions. Return timestamped evidence, not blanket health or retained verification state.",
    permissions: [BACKOFFICE_PERMISSION.integrations.manage],
    input: integrationConnectionInputSchema,
    output: integrationConnectionSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
