import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";

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

/** Authoritative catalog contracts describe action values, not a provider's execution permissions. */
export const projectConnectorActionSchema = z.object({
  id: z.string().min(1),
  service: z.string().min(1),
  name: z.string(),
  description: z.string().nullable(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
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

/** Project authentication does not imply that an individual provider account is usable. */
export const projectConnectorStatusSchema = z.object({ authenticated: z.literal(true) });

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

/** Only actions allowed by this exact project OAuth configuration are included. */
export const projectConnectorProviderActionsSchema = z.object({
  projectId: projectConnectorProviderConfigsSchema.shape.projectId,
  providerConfigId: projectConnectorProviderConfigsSchema.shape.providerConfigs.element.shape.id,
  actions: z.array(projectConnectorActionSchema),
});

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

/** Account pagination is owned by the fragment rather than the provider gateway. */
export const projectConnectorAccountsSchema = z.object({
  accounts: z.array(projectConnectorAccountSchema),
  cursor: z.string().nullable(),
  hasNextPage: z.boolean(),
});

export const accountsInputSchema = z
  .strictObject({ cursor: z.string().nullable().default(null) })
  .optional()
  .default({ cursor: null });

export const profileInputSchema = z.strictObject({ accountId: z.string().min(1) });

export const actionInputSchema = profileInputSchema.extend({
  actionId: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
});

export const connectInputSchema = z.union([
  projectConnectorConnectInputSchema.options[0].omit({ returnUri: true }),
  projectConnectorConnectInputSchema.options[1].omit({ returnUri: true }),
]);

export const noInputSchema = z.void();

export const providerActionsInputSchema = z.strictObject({
  providerConfigId: projectConnectorProviderActionsSchema.shape.providerConfigId,
});

export const requestInputSchema = z.strictObject({ requestId: z.string().min(1) });

export const connectorOperations = {
  "connector.providers.list": {
    description:
      "List the project's OAuth provider configuration overviews without action IDs. Use listProviderActions for a selected providerConfigId; discovery does not verify user accounts.",
    permissions: [BACKOFFICE_PERMISSION.connector.providersRead],
    input: noInputSchema,
    output: projectConnectorProviderConfigsSchema,
  },
  "connector.providers.actions": {
    description:
      "List authoritative action definitions, including input/output JSON Schemas, allowed by one exact OAuth provider configuration. Catalog discovery never grants execution permission.",
    permissions: [BACKOFFICE_PERMISSION.connector.providersRead],
    input: providerActionsInputSchema,
    output: projectConnectorProviderActionsSchema,
  },
  "connector.status": {
    description: "Check gateway project-key authentication, not individual provider availability.",
    permissions: [BACKOFFICE_PERMISSION.connector.accountsRead],
    input: noInputSchema,
    output: projectConnectorStatusSchema,
  },
  "connector.connect": {
    description:
      "Start provider OAuth for the owning user. Return the authorization URL and retain the request ID for refresh.",
    permissions: [BACKOFFICE_PERMISSION.connector.connectionsCreate],
    input: connectInputSchema,
    output: projectConnectorConnectionSchema,
  },
  "connector.connections.refresh": {
    description:
      "Verify a saved OAuth request against the gateway and persist a confirmed account binding. Callback query parameters are not proof.",
    permissions: [BACKOFFICE_PERMISSION.connector.connectionsCreate],
    input: requestInputSchema,
    output: projectConnectorConnectionSchema,
  },
  "connector.accounts.list": {
    description: "List the owning user's locally verified accounts, one cursor page at a time.",
    permissions: [BACKOFFICE_PERMISSION.connector.accountsRead],
    input: accountsInputSchema,
    output: projectConnectorAccountsSchema,
  },
  "connector.accounts.profile": {
    description:
      "Read the provider identity of a verified account; this does not read Gmail messages.",
    permissions: [BACKOFFICE_PERMISSION.connector.accountsRead],
    input: profileInputSchema,
    output: projectConnectorProfileSchema,
  },
  "connector.actions.execute": {
    description:
      "Execute an explicit provider action on a verified account. Actions can write external data and are never automatically retried.",
    permissions: [BACKOFFICE_PERMISSION.connector.actionsExecute],
    input: actionInputSchema,
    output: projectConnectorExecutionSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
