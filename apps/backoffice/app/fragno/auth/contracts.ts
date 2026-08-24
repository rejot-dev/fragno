import { z } from "zod";

import {
  backofficeContextScopeSchema,
  type BackofficeContextScope,
} from "@/backoffice-runtime/context";

export const BACKOFFICE_AUTH_ERROR_HEADER = "x-backoffice-auth-error";
export const BACKOFFICE_TOKEN_EXPIRED_CODE = "backoffice_token_expired";

export type Role = "user" | "admin";

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: Role;
  banned: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type UserSummary = Pick<AuthUser, "id" | "email" | "role"> & {
  bannedAt: Date | null;
};

export type Organization = {
  id: string;
  name: string;
  slug: string;
  logoUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
};

export type OrganizationMember = {
  id: string;
  organizationId: string;
  userId: string;
  roles: string[];
  createdAt: Date;
  updatedAt: Date;
};

export type OrganizationInvitation = {
  id: string;
  token?: string;
  organizationId: string;
  email: string;
  roles: string[];
  status: "pending" | "accepted" | "rejected" | "canceled" | "expired";
  inviterId: string;
  expiresAt: Date;
  createdAt: Date;
};

export type OrganizationMembership = {
  organization: Organization;
  member: OrganizationMember;
};

export type OrganizationInvitationSummary = {
  invitation: OrganizationInvitation;
  organization: Organization;
};

export type BackofficeMeData = {
  user: AuthUser;
  organizations: OrganizationMembership[];
  activeOrganizationId: string | null;
  activeOrganization: OrganizationMembership | null;
  invitations: OrganizationInvitationSummary[];
};

export type IssueBackofficeTokenInput =
  | {
      selection: "preferred";
      organizationId: string | null;
    }
  | {
      selection: "required";
      organizationId: string;
    };

export type IssueBackofficeTokenResult = {
  expiresAt: string;
  organizationId: string | null;
};

export type BackofficeCliOAuthConfig = {
  clientId: string;
  scope: string;
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  verificationUri: string;
};

export type BackofficeCliTokenInput = {
  scope: BackofficeContextScope | null;
};

export type BackofficeCliTokenResult = {
  accessToken: string;
  expiresAt: string;
  scope: BackofficeContextScope;
};

/** Reports an OAuth credential that cannot authenticate the Backoffice CLI. */
export class BackofficeCliOAuthAuthenticationError extends Error {
  override readonly name = "BackofficeCliOAuthAuthenticationError";
}

/** Reports an authenticated user that cannot access the requested Backoffice scope. */
export class BackofficeCliScopeAuthorizationError extends Error {
  override readonly name = "BackofficeCliScopeAuthorizationError";
}

export type BackofficeSignOutResult = {
  sessionRevoked: true;
  credentialsCleared: true;
};

const authUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  role: z.enum(["user", "admin"]),
  banned: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}) satisfies z.ZodType<AuthUser>;

const organizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  logoUrl: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  createdBy: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  deletedAt: z.coerce.date().nullable().optional(),
}) satisfies z.ZodType<Organization>;

const organizationMemberSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  roles: z.array(z.string()),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}) satisfies z.ZodType<OrganizationMember>;

const organizationInvitationSchema = z.object({
  id: z.string(),
  token: z.string().optional(),
  organizationId: z.string(),
  email: z.string(),
  roles: z.array(z.string()),
  status: z.enum(["pending", "accepted", "rejected", "canceled", "expired"]),
  inviterId: z.string(),
  expiresAt: z.coerce.date(),
  createdAt: z.coerce.date(),
}) satisfies z.ZodType<OrganizationInvitation>;

const organizationMembershipSchema = z.object({
  organization: organizationSchema,
  member: organizationMemberSchema,
});

const organizationInvitationSummarySchema = z.object({
  invitation: organizationInvitationSchema,
  organization: organizationSchema,
});

export const backofficeMeDataSchema = z.object({
  user: authUserSchema,
  organizations: z.array(organizationMembershipSchema),
  activeOrganizationId: z.string().nullable(),
  activeOrganization: organizationMembershipSchema.nullable(),
  invitations: z.array(organizationInvitationSummarySchema),
}) satisfies z.ZodType<BackofficeMeData>;

export const issueBackofficeTokenInputSchema = z.discriminatedUnion("selection", [
  z.object({
    selection: z.literal("preferred"),
    organizationId: z.string().trim().min(1).nullable(),
  }),
  z.object({
    selection: z.literal("required"),
    organizationId: z.string().trim().min(1),
  }),
]) satisfies z.ZodType<IssueBackofficeTokenInput>;

export const issueBackofficeTokenResultSchema = z.object({
  expiresAt: z.iso.datetime(),
  organizationId: z.string().nullable(),
}) satisfies z.ZodType<IssueBackofficeTokenResult>;

export const backofficeCliOAuthConfigSchema = z.object({
  clientId: z.string().min(1),
  scope: z.string().min(1),
  deviceAuthorizationEndpoint: z.url(),
  tokenEndpoint: z.url(),
  verificationUri: z.url(),
}) satisfies z.ZodType<BackofficeCliOAuthConfig>;

export const backofficeCliTokenInputSchema = z.strictObject({
  scope: backofficeContextScopeSchema.nullable(),
}) satisfies z.ZodType<BackofficeCliTokenInput>;

export const backofficeCliTokenResultSchema = z.strictObject({
  accessToken: z.string().min(1),
  expiresAt: z.iso.datetime(),
  scope: backofficeContextScopeSchema,
}) satisfies z.ZodType<BackofficeCliTokenResult>;

export const backofficeSignOutResultSchema = z.object({
  sessionRevoked: z.literal(true),
  credentialsCleared: z.literal(true),
}) satisfies z.ZodType<BackofficeSignOutResult>;

export type UserAuthorityFacts = Readonly<{
  active: boolean;
  role: Role | null;
  organizationMember: boolean;
}>;

export type VerifyUserEmailInput = {
  userId: string;
  expectedEmail?: string;
  verifiedAt: Date;
};

export type VerifyUserEmailResult =
  | { ok: true; status: "verified" | "already_verified"; emailVerifiedAt: Date }
  | { ok: false; code: "user_not_found" | "email_changed" };

export type OrganizationHookPayload = {
  organization: Organization;
  actor: UserSummary | null;
};

export type AuthHookContext = {
  hookId: string | { toString(): string };
  capturePropagationContext(): Readonly<Record<string, string>> | null;
};

export type OrganizationHooks = {
  onOrganizationCreated?(payload: OrganizationHookPayload, context: AuthHookContext): Promise<void>;
  onOrganizationUpdated?(payload: OrganizationHookPayload, context: AuthHookContext): Promise<void>;
};

const DEV_ACCESS_TOKEN_SECRET = "fragno-backoffice-development-access-token-secret";

export type BackofficeAuthPrincipal = {
  user: Pick<AuthUser, "id" | "email" | "role">;
  auth: {
    transport: "cookie" | "bearer";
    expiresAt: Date;
    scope: BackofficeContextScope;
    organizationRoles: string[];
  };
};

export const resolveLiveAccessTokenSecret = (env: CloudflareEnv, isDev: boolean): string => {
  const configuredSecret = env.AUTH_ACCESS_TOKEN_SECRET?.trim();
  if (configuredSecret) {
    if (configuredSecret.length < 32) {
      throw new Error("AUTH_ACCESS_TOKEN_SECRET must contain at least 32 characters.");
    }
    return configuredSecret;
  }
  if (isDev) {
    return DEV_ACCESS_TOKEN_SECRET;
  }
  throw new Error("AUTH_ACCESS_TOKEN_SECRET must be configured for backoffice auth.");
};

export const splitOrganizationRoles = (role: string): string[] =>
  [
    ...new Set(
      role.split(",").flatMap((value) => {
        const trimmedValue = value.trim();
        return trimmedValue ? [trimmedValue] : [];
      }),
    ),
  ].sort();

export const joinOrganizationRoles = (roles: readonly string[]): string =>
  [
    ...new Set(
      roles.flatMap((value) => {
        const trimmedValue = value.trim();
        return trimmedValue ? [trimmedValue] : [];
      }),
    ),
  ]
    .sort()
    .join(",");
