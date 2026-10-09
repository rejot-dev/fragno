import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { organizationMembershipRecordSchema, organizationRecordSchema } from "./organization";
import { directoryPageInputSchema } from "./shared/pagination";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";

/** The signed-in user's own profile; it never describes another user. */
const accountProfileSchema = z
  .strictObject({
    userId: z.string().min(1),
    name: z.string(),
    email: z.string().min(1),
    emailVerified: z.boolean(),
    systemRole: z.enum(["user", "admin"]),
  })
  .meta({ id: "AccountProfile" });
export type AccountProfile = z.output<typeof accountProfileSchema>;

/** A pending invitation addressed to the signed-in user's email. */
const accountInvitationRecordSchema = z
  .strictObject({
    invitationId: z.string().min(1),
    organization: organizationRecordSchema,
    roles: z.array(z.string().min(1)).min(1),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: "AccountInvitationRecord" });
export type AccountInvitationRecord = z.output<typeof accountInvitationRecordSchema>;

/** User-facing authorizations contain no access tokens, refresh tokens, or client secrets. */
export const oauthConsentPageSchema = z
  .object({
    consents: z.array(
      z.object({
        id: z.string(),
        clientId: z.string(),
        clientName: z.string(),
        scopes: z.array(z.string()),
        resources: z.array(z.string()),
        requestedUserInfoClaims: z.array(z.string()),
        createdAt: z.string(),
        updatedAt: z.string(),
      }),
    ),
    nextCursor: z.string().nullable(),
    hasNextPage: z.boolean(),
  })
  .meta({ id: "OAuthConsentPage" });
export type OAuthConsentPage = z.output<typeof oauthConsentPageSchema>;

/** Account operations act on the calling user only; no operation can target another account. */
export const accountOperations = {
  "account.me": {
    description: "Read your own Backoffice account profile.",
    permissions: [BACKOFFICE_PERMISSION.account.read],
    input: z.void(),
    output: accountProfileSchema,
  },
  "account.profile.update": {
    description: "Change the display name on your own Backoffice account.",
    permissions: [BACKOFFICE_PERMISSION.account.manage],
    input: z.strictObject({ name: z.string().trim().min(1) }),
    output: accountProfileSchema,
  },
  "account.orgs.list": {
    description: "List the organizations you belong to and your roles in each.",
    permissions: [BACKOFFICE_PERMISSION.account.read],
    input: z.void(),
    output: z.strictObject({ organizations: z.array(organizationMembershipRecordSchema) }),
  },
  "account.invitations.list": {
    description: "List pending, unexpired organization invitations addressed to your email.",
    permissions: [BACKOFFICE_PERMISSION.account.read],
    input: z.void(),
    output: z.strictObject({ invitations: z.array(accountInvitationRecordSchema) }),
  },
  "account.invitations.accept": {
    description: "Accept a pending organization invitation addressed to your email.",
    permissions: [BACKOFFICE_PERMISSION.account.manage],
    input: z.strictObject({ invitationId: z.string().trim().min(1) }),
    output: organizationMembershipRecordSchema,
  },
  "account.applications.list": {
    description:
      "List OAuth applications you have authorized and their granted scopes, using cursor pagination. Never exposes tokens.",
    permissions: [BACKOFFICE_PERMISSION.account.read],
    input: directoryPageInputSchema,
    output: oauthConsentPageSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
