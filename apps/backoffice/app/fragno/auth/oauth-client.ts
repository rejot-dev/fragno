import { z } from "zod";

/** OAuth identity scopes are separate from app declarations and organization installation grants. */
export const BACKOFFICE_OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "backoffice",
] as const;

/** Creates authorization-code web or native clients; both require PKCE. */
export const backofficeOAuthClientCreateInputSchema = z
  .strictObject({
    name: z.string().trim().min(1),
    redirectUris: z.array(z.url()).min(1),
    scopes: z.array(z.enum(BACKOFFICE_OAUTH_SCOPES)).min(1),
    clientType: z.enum(["confidential", "public"]).default("confidential"),
    applicationType: z.enum(["web", "native"]).default("web"),
  })
  .meta({ id: "BackofficeOAuthClientCreateInput" });

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

/** Parsed OAuth client creation parameters, before assigning the authenticated administrator owner. */
export type BackofficeOAuthClientCreateInput = z.output<
  typeof backofficeOAuthClientCreateInputSchema
>;

/** Creation result distinguishes confidential credentials from secretless public clients. */
export type BackofficeOAuthClientCreateResult = z.output<
  typeof backofficeOAuthClientCreateResultSchema
>;
