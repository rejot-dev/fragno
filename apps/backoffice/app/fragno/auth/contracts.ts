import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import type { BackofficeRuntimeEnv } from "@/backoffice-runtime/backoffice-runtime-env";

export const BACKOFFICE_AUTH_ERROR_HEADER = "x-backoffice-auth-error";

/**
 * The visitor's IP, which Cloudflare sets at its edge, replacing any value a client sends. Auth's
 * rate limits read only this header.
 */
export const CLIENT_IP_HEADER = "cf-connecting-ip";
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

export type OrganizationInvitation = {
  id: string;
  organizationId: string;
  email: string;
  roles: string[];
  status: "pending" | "accepted" | "rejected" | "canceled" | "expired";
  inviterId: string;
  expiresAt: Date;
  createdAt: Date;
};

/**
 * An organization the user acts in, with their roles there: as one of its members, or as a member
 * of the organization that manages it, which grants access but not membership.
 */
export type OrganizationMembership = {
  organization: Organization;
  roles: string[];
  through:
    | { kind: "membership" }
    | {
        kind: "managing-organization";
        organization: Pick<Organization, "id" | "name" | "slug">;
      };
};

export type BackofficeMeData = {
  user: AuthUser;
  organizations: OrganizationMembership[];
  activeOrganizationId: string | null;
  activeOrganization: OrganizationMembership | null;
};

/** "preferred" keeps the Auth session's organization; "required" switches the session to one. */
export type IssueBackofficeTokenInput =
  | {
      selection: "preferred";
    }
  | {
      selection: "required";
      organizationId: string;
    };

export type IssueBackofficeTokenResult = {
  expiresAt: string;
  organization: Pick<Organization, "id" | "slug"> | null;
};

export type BackofficeCliOAuthConfig = {
  clientId: string;
  scope: string;
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  verificationUri: string;
};

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

const organizationMembershipSchema = z.object({
  organization: organizationSchema,
  roles: z.array(z.string()),
  through: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("membership") }),
    z.object({
      kind: z.literal("managing-organization"),
      organization: z.object({ id: z.string(), name: z.string(), slug: z.string() }),
    }),
  ]),
}) satisfies z.ZodType<OrganizationMembership>;

export const backofficeMeDataSchema = z.object({
  user: authUserSchema,
  organizations: z.array(organizationMembershipSchema),
  activeOrganizationId: z.string().nullable(),
  activeOrganization: organizationMembershipSchema.nullable(),
}) satisfies z.ZodType<BackofficeMeData>;

export const issueBackofficeTokenInputSchema = z.discriminatedUnion("selection", [
  z.strictObject({
    selection: z.literal("preferred"),
  }),
  z.strictObject({
    selection: z.literal("required"),
    organizationId: z.string().trim().min(1),
  }),
]) satisfies z.ZodType<IssueBackofficeTokenInput>;

export const issueBackofficeTokenResultSchema = z.object({
  expiresAt: z.iso.datetime(),
  organization: z
    .object({
      id: z.string(),
      slug: z.string(),
    })
    .nullable(),
}) satisfies z.ZodType<IssueBackofficeTokenResult>;

export const backofficeCliOAuthConfigSchema = z.object({
  clientId: z.string().min(1),
  scope: z.string().min(1),
  deviceAuthorizationEndpoint: z.url(),
  tokenEndpoint: z.url(),
  verificationUri: z.url(),
}) satisfies z.ZodType<BackofficeCliOAuthConfig>;

export const backofficeSignOutResultSchema = z.object({
  sessionRevoked: z.literal(true),
  credentialsCleared: z.literal(true),
}) satisfies z.ZodType<BackofficeSignOutResult>;

export type UserAuthorityFacts = Readonly<{
  active: boolean;
  role: Role | null;
  organizationMember: boolean;
}>;

/** Live user and membership facts for organization management, without session or directory data. */
export const userOrganizationAuthorityInputSchema = z.strictObject({
  userId: z.string().min(1),
  organizationId: z.string().min(1),
});
export type UserOrganizationAuthorityInput = z.infer<typeof userOrganizationAuthorityInputSchema>;
export type UserOrganizationAuthorityFacts = Readonly<{
  active: boolean;
  role: Role | null;
  organizationRoles: readonly string[] | null;
}>;

/**
 * A user whose personal workspace another user may act in, because that user is an owner or admin
 * of an organization the member belongs to, or of the organization managing it. `organization` is
 * the member's organization that grants it, one the administrator belongs to when there is one.
 */
export type AdministeredMember = Readonly<{
  userId: string;
  name: string;
  email: string;
  organization: Readonly<{ id: string; name: string; slug: string }>;
}>;

/** Whether an organization's member with these roles may act in its members' personal workspaces. */
export function administersMembers(roles: readonly string[]): boolean {
  return roles.some((role) => role === "owner" || role === "admin");
}

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
    scopeRestriction: BackofficeContextScope | null;
    organization: { id: string; slug: string; roles: string[] } | null;
  };
};

export const resolveLiveAccessTokenSecret = (
  env: Pick<BackofficeRuntimeEnv, "AUTH_ACCESS_TOKEN_SECRET">,
  isDev: boolean,
): string => {
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
