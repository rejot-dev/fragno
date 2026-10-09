import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { directoryPageInputSchema } from "./shared/pagination";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";

export const organizationRoleSchema = z.enum(["owner", "admin", "member"]);
export type OrganizationRole = z.output<typeof organizationRoleSchema>;

export const organizationRecordSchema = z
  .strictObject({
    organizationId: z.string().min(1),
    name: z.string().min(1),
    slug: z.string().min(1),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: "OrganizationRecord" });
export type OrganizationRecord = z.output<typeof organizationRecordSchema>;

/** One user's membership: the organization and the roles that user holds in it. */
export const organizationMembershipRecordSchema = z
  .strictObject({
    organization: organizationRecordSchema,
    roles: z.array(z.string().min(1)).min(1),
  })
  .meta({ id: "OrganizationMembershipRecord" });
export type OrganizationMembershipRecord = z.output<typeof organizationMembershipRecordSchema>;

const organizationMemberRecordSchema = z
  .strictObject({
    userId: z.string().min(1),
    name: z.string(),
    email: z.string().min(1),
    roles: z.array(z.string().min(1)).min(1),
    joinedAt: z.iso.datetime(),
  })
  .meta({ id: "OrganizationMemberRecord" });

export const organizationMemberPageSchema = z
  .strictObject({
    members: z.array(organizationMemberRecordSchema),
    nextCursor: z.string().nullable(),
    hasNextPage: z.boolean(),
  })
  .meta({ id: "OrganizationMemberPage" });
export type OrganizationMemberPage = z.output<typeof organizationMemberPageSchema>;

/** Only unexpired pending invitations are listed; accepted or expired ones are history. */
export const organizationInvitationRecordSchema = z
  .strictObject({
    invitationId: z.string().min(1),
    organizationId: z.string().min(1),
    email: z.string().min(1),
    roles: z.array(z.string().min(1)).min(1),
    expiresAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: "OrganizationInvitationRecord" });
export type OrganizationInvitationRecord = z.output<typeof organizationInvitationRecordSchema>;

/** Invitations are not emailed; the inviter shares this link. */
const organizationInvitationLinkSchema = organizationInvitationRecordSchema
  .extend({ url: z.url() })
  .meta({ id: "OrganizationInvitationLink" });
export type OrganizationInvitationLink = z.output<typeof organizationInvitationLinkSchema>;

const organizationInvitationLinkPageSchema = z
  .strictObject({
    invitations: z.array(organizationInvitationLinkSchema),
    nextCursor: z.string().nullable(),
    hasNextPage: z.boolean(),
  })
  .meta({ id: "OrganizationInvitationLinkPage" });
export type OrganizationInvitationLinkPage = z.output<typeof organizationInvitationLinkPageSchema>;

/** Organization operations act on the scoped organization as the calling user. */
export const organizationOperations = {
  "org.get": {
    description: "Read the current organization and your roles in it.",
    permissions: [BACKOFFICE_PERMISSION.org.read],
    input: z.void(),
    output: organizationMembershipRecordSchema,
  },
  "org.update": {
    description: "Rename the current organization. Requires the owner or admin role.",
    permissions: [BACKOFFICE_PERMISSION.org.manage],
    input: z.strictObject({ name: z.string().trim().min(1) }),
    output: organizationRecordSchema,
  },
  "org.members.list": {
    description:
      "List members of the current organization with their roles, using cursor pagination.",
    permissions: [BACKOFFICE_PERMISSION.org.read],
    input: directoryPageInputSchema,
    output: organizationMemberPageSchema,
  },
  "org.invitations.list": {
    description:
      "List pending, unexpired invitations to the current organization with their shareable links, using cursor pagination.",
    permissions: [BACKOFFICE_PERMISSION.org.read],
    input: directoryPageInputSchema,
    output: organizationInvitationLinkPageSchema,
  },
  "org.invitations.create": {
    description:
      "Invite an email address to the current organization and return a shareable link. Invitations are not emailed. Requires the owner or admin role; only owners may invite owners.",
    permissions: [BACKOFFICE_PERMISSION.org.manage],
    input: z.strictObject({
      email: z.string().trim().toLowerCase().pipe(z.email()),
      roles: z.array(organizationRoleSchema).min(1),
    }),
    output: organizationInvitationLinkSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
