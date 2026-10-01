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

/** Select exactly one provider and name every connection explicitly. */
export const projectConnectorConnectInputSchema = z.union([
  z.strictObject({
    service: z.string().regex(/^[a-z0-9_-]+$/),
    connectionName: z.string().min(1),
    returnUri: projectConnectorHttpUrlSchema,
  }),
  z.strictObject({
    providerConfigId: z.string().min(1),
    connectionName: z.string().min(1),
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

/** Account pagination is owned by the fragment rather than the provider gateway. */
export const projectConnectorAccountsSchema = z.object({
  accounts: z.array(projectConnectorAccountSchema),
  cursor: z.string().nullable(),
  hasNextPage: z.boolean(),
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
