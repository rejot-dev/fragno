import { z } from "zod";

/** OAuth identity scopes are separate from app declarations and organization installation grants. */
export const BACKOFFICE_OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "backoffice",
] as const;

/** Installed apps acting as themselves receive only execution access, never identity scopes. */
export const BACKOFFICE_CLIENT_CREDENTIALS_SCOPES = ["backoffice"] as const;

const clientCredentialsRequiresBackofficeScope = {
  message: "Client credentials require the backoffice OAuth scope.",
  path: ["clientCredentials"],
};

/**
 * Creates authorization-code web or native clients; both require PKCE. Confidential clients may
 * also use client credentials, letting an installed app act as its installation.
 */
export const backofficeOAuthClientCreateInputSchema = z
  .strictObject({
    name: z.string().trim().min(1),
    redirectUris: z.array(z.url()).min(1),
    scopes: z.array(z.enum(BACKOFFICE_OAUTH_SCOPES)).min(1),
    clientType: z.enum(["confidential", "public"]).default("confidential"),
    applicationType: z.enum(["web", "native"]).default("web"),
    clientCredentials: z.boolean().default(false),
  })
  .refine(
    ({ clientCredentials, scopes }) => !clientCredentials || scopes.includes("backoffice"),
    clientCredentialsRequiresBackofficeScope,
  )
  .refine(
    ({ clientCredentials, clientType }) => !clientCredentials || clientType === "confidential",
    {
      message: "Client credentials require a confidential client.",
      path: ["clientCredentials"],
    },
  )
  .meta({ id: "BackofficeOAuthClientCreateInput" });

/**
 * Replaces a client's redirects, scopes, and client-credentials access. Widening scopes does not
 * widen existing consents; users authorize again to grant new scopes.
 */
export const backofficeOAuthClientUpdateInputSchema = z
  .strictObject({
    clientId: z.string().min(1).max(191),
    redirectUris: z.array(z.url()).min(1),
    scopes: z.array(z.enum(BACKOFFICE_OAUTH_SCOPES)).min(1),
    clientCredentials: z.boolean(),
  })
  .refine(
    ({ clientCredentials, scopes }) => !clientCredentials || scopes.includes("backoffice"),
    clientCredentialsRequiresBackofficeScope,
  )
  .meta({ id: "BackofficeOAuthClientUpdateInput" });

/** Credential-free view of the updated client settings. */
export const backofficeOAuthClientUpdateResultSchema = z
  .strictObject({
    clientId: z.string().min(1),
    redirectUris: z.array(z.string()),
    scopes: z.array(z.string()),
    clientCredentials: z.boolean(),
  })
  .meta({ id: "BackofficeOAuthClientUpdateResult" });

export const backofficeOAuthClientRotateSecretInputSchema = z
  .strictObject({ clientId: z.string().min(1).max(191) })
  .meta({ id: "BackofficeOAuthClientRotateSecretInput" });

/** The new secret is returned once; the previous secret stops authenticating immediately. */
export const backofficeOAuthClientRotateSecretResultSchema = z
  .strictObject({ clientId: z.string().min(1), clientSecret: z.string().min(1) })
  .meta({ id: "BackofficeOAuthClientRotateSecretResult" });

/** Authorization-code is always allowed; refresh and client credentials follow explicit settings. */
export function backofficeOAuthClientGrantTypes(input: {
  scopes: readonly string[];
  clientCredentials: boolean;
}): string[] {
  return [
    "authorization_code",
    ...(input.scopes.includes("offline_access") ? ["refresh_token"] : []),
    ...(input.clientCredentials ? ["client_credentials"] : []),
  ];
}

/** Credential-free Auth facts used to validate app registration and installation redirects. */
export type BackofficeOAuthClientFacts = {
  clientId: string;
  name: string | null;
  redirectUris: string[];
  scopes: string[];
  disabled: boolean;
  /** The deployment's Codemode client: first-party, never an app, and not administrator-owned. */
  managedByBackoffice: boolean;
};

/** A confidential client's initial secret is returned at creation, never fetched from storage. */
export const backofficeOAuthClientCreateResultSchema = z
  .discriminatedUnion("clientType", [
    z.strictObject({
      clientType: z.literal("confidential"),
      clientId: z.string().min(1),
      clientSecret: z.string().min(1),
    }),
    z.strictObject({
      clientType: z.literal("public"),
      clientId: z.string().min(1),
      clientSecret: z.null(),
    }),
  ])
  .meta({ id: "BackofficeOAuthClientCreateResult" });

/** Bounds the global OAuth client catalog using an opaque cursor and a fixed page size. */
export const backofficeOAuthClientListInputSchema = z
  .strictObject({
    pageSize: z.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).nullable().default(null),
  })
  .meta({ id: "BackofficeOAuthClientListInput" });

/** Auth-owned client metadata deliberately excludes credentials and credential hashes. */
export const backofficeOAuthClientSummarySchema = z
  .strictObject({
    clientId: z.string().min(1),
    name: z.string().nullable(),
    redirectUris: z.array(z.string()).nullable(),
    scopes: z.array(z.string()).nullable(),
    tokenEndpointAuthMethod: z.string().nullable(),
    userId: z.string().nullable(),
    referenceId: z.string().nullable(),
    disabled: z.boolean().nullable(),
  })
  .meta({ id: "BackofficeOAuthClientSummary" });

/** Global client pages contain metadata only, including clients owned by other administrators. */
export const backofficeOAuthClientPageSchema = z
  .strictObject({
    clients: z.array(backofficeOAuthClientSummarySchema),
    nextCursor: z.string().nullable(),
    hasNextPage: z.boolean(),
  })
  .meta({ id: "BackofficeOAuthClientPage" });

/** Parsed OAuth client listing parameters; resume with the same page size. */
export type BackofficeOAuthClientListInput = z.output<typeof backofficeOAuthClientListInputSchema>;

/** Credential-free projection of the Auth-owned OAuth client model. */
export type BackofficeOAuthClientSummary = z.output<typeof backofficeOAuthClientSummarySchema>;

/** A cursor page of the global Auth-owned OAuth client catalog. */
export type BackofficeOAuthClientPage = z.output<typeof backofficeOAuthClientPageSchema>;

/** Unparsed creation parameters accepted at the Auth RPC boundary, which applies defaults. */
export type BackofficeOAuthClientCreateRequest = z.input<
  typeof backofficeOAuthClientCreateInputSchema
>;

/** Parsed OAuth client creation parameters, before assigning the authenticated administrator owner. */
export type BackofficeOAuthClientCreateInput = z.output<
  typeof backofficeOAuthClientCreateInputSchema
>;

/** Creation result distinguishes confidential credentials from secretless public clients. */
export type BackofficeOAuthClientCreateResult = z.output<
  typeof backofficeOAuthClientCreateResultSchema
>;

export type BackofficeOAuthClientUpdateInput = z.output<
  typeof backofficeOAuthClientUpdateInputSchema
>;
export type BackofficeOAuthClientUpdateResult = z.output<
  typeof backofficeOAuthClientUpdateResultSchema
>;
export type BackofficeOAuthClientRotateSecretInput = z.output<
  typeof backofficeOAuthClientRotateSecretInputSchema
>;
export type BackofficeOAuthClientRotateSecretResult = z.output<
  typeof backofficeOAuthClientRotateSecretResultSchema
>;
