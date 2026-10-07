import { z } from "zod";

/** Only HTTP(S) URLs can be used as OAuth return destinations. */
export const projectConnectorHttpUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
}, "Expected an HTTP(S) URL without embedded credentials");

/** A connection becomes usable only after the gateway confirms its account ID. */
export const projectConnectorConnectionStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("initiated") }),
  z.object({ status: z.literal("connected"), connectedAccountId: z.string().min(1) }),
  z.object({
    status: z.literal("failed"),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
  }),
  z.object({ status: z.literal("expired") }),
]);

/** Persisted connection lifecycle; provider credentials never enter this fragment. */
export type ProjectConnectorConnectionState = z.infer<typeof projectConnectorConnectionStateSchema>;

/** Mirrors the gateway's alias rule so invalid names fail here with a usable message. */
const projectConnectorConnectionNameSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]*$/,
    "Connection names may only contain lowercase letters, digits, underscores, and hyphens, and must start with a letter or digit",
  )
  .describe("Lowercase letters, digits, underscores, and hyphens; starts with a letter or digit.");

/** Named selectors preserve exact source identity; user ownership comes only from authentication. */
export const projectConnectorNamedConnectionSchema = z.strictObject({
  projectId: z.string().min(1),
  providerConfigId: z.string().min(1),
  connectionName: projectConnectorConnectionNameSchema,
});

/** Select exactly one provider and name every connection explicitly. */
export const projectConnectorConnectInputSchema = z.union([
  z.strictObject({
    service: z.string().regex(/^[a-z0-9_-]+$/),
    connectionName: projectConnectorNamedConnectionSchema.shape.connectionName,
    returnUri: projectConnectorHttpUrlSchema,
  }),
  z.strictObject({
    providerConfigId: projectConnectorNamedConnectionSchema.shape.providerConfigId,
    connectionName: projectConnectorNamedConnectionSchema.shape.connectionName,
    returnUri: projectConnectorHttpUrlSchema,
  }),
]);

/** Public connection request projection, including its verified lifecycle. */
export const projectConnectorConnectionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  providerConfigId: z.string(),
  externalUserId: z.string(),
  service: z.string(),
  connectionName: z.string().nullable(),
  authorizationUrl: projectConnectorHttpUrlSchema,
  expiresAt: z.string(),
  state: projectConnectorConnectionStateSchema,
});

/** Stored account selectors bind actions to a specific product user and provider. */
export const projectConnectorAccountSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  providerConfigId: z.string(),
  externalUserId: z.string(),
  service: z.string(),
  connectionName: z.string().nullable(),
});

/** Missing named requests remain JSON results rather than empty HTTP responses. */
export const projectConnectorNamedRequestSchema = z.strictObject({
  request: projectConnectorConnectionSchema.nullable(),
});

/** Missing named accounts remain JSON results rather than empty HTTP responses. */
export const projectConnectorNamedAccountSchema = z.strictObject({
  account: projectConnectorAccountSchema.nullable(),
});

/** Account pagination is owned by the fragment rather than the provider gateway. */
export const projectConnectorAccountsSchema = z.object({
  accounts: z.array(projectConnectorAccountSchema),
  cursor: z.string().nullable(),
  hasNextPage: z.boolean(),
});

/** Project-scoped OAuth provider overview excludes action IDs and credentials. */
export const projectConnectorProviderConfigsSchema = z
  .object({
    projectId: z.string().min(1),
    providerConfigs: z.array(
      z.object({
        id: z.string().min(1),
        service: z.string().min(1),
        displayName: z.string(),
        callbackUrl: projectConnectorHttpUrlSchema,
        effectiveScopes: z.array(z.string().min(1)),
        proxyAvailable: z.boolean(),
      }),
    ),
  })
  .refine(
    ({ providerConfigs }) =>
      new Set(providerConfigs.map((config) => config.id)).size === providerConfigs.length,
    "Provider configuration IDs must be unique",
  );

/** Authoritative catalog contracts describe action values, not a provider's execution permissions. */
export const projectConnectorActionSchema = z.object({
  id: z.string().min(1),
  service: z.string().min(1),
  name: z.string(),
  description: z.string().nullable(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
});

/** Only actions allowed by this exact project OAuth configuration are included. */
export const projectConnectorProviderActionsSchema = z.object({
  projectId: projectConnectorProviderConfigsSchema.shape.projectId,
  providerConfigId: projectConnectorProviderConfigsSchema.shape.providerConfigs.element.shape.id,
  actions: z.array(projectConnectorActionSchema),
});

/** Project authentication does not imply that an individual provider account is usable. */
export const projectConnectorStatusSchema = z.object({ authenticated: z.literal(true) });

/** Read-only provider identity associated with one verified account. */
export const projectConnectorProfileSchema = z.object({
  connectedAccountId: z.string(),
  externalUserId: z.string(),
  service: z.string(),
  profile: z.object({
    id: z.string(),
    kind: z.string(),
    username: z.string().nullable(),
    displayName: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    email: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
  }),
  fetchedAt: z.number(),
});

/** Action output stays opaque; execution IDs support upstream troubleshooting. */
export const projectConnectorExecutionSchema = z.object({
  executionId: z.string(),
  actionId: z.string(),
  output: z.unknown().refine((value) => value !== undefined, "Expected action output"),
});
