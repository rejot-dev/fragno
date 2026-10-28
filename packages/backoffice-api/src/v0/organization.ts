import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { directoryPageInputSchema } from "./shared/pagination";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";
import { backofficeJurisdictionSchema } from "./shared/scope";

export const organizationRoleSchema = z.lazy(() => z.enum(["owner", "admin", "member"]));
export type OrganizationRole = z.output<typeof organizationRoleSchema>;

export const organizationRecordSchema = z
  .lazy(() =>
    z.strictObject({
      organizationId: z.string().min(1),
      name: z.string().min(1),
      slug: z.string().min(1),
      // Scopes name the organization with it: `{ kind: "org", orgId, jurisdiction }`.
      jurisdiction: backofficeJurisdictionSchema.nullable(),
      createdAt: z.iso.datetime(),
    }),
  )
  .meta({ id: "OrganizationRecord" });
export type OrganizationRecord = z.output<typeof organizationRecordSchema>;

/** One user's membership: the organization and the roles that user holds in it. */
export const organizationMembershipRecordSchema = z
  .lazy(() =>
    z.strictObject({
      organization: organizationRecordSchema,
      roles: z.array(z.string().min(1)).min(1),
    }),
  )
  .meta({ id: "OrganizationMembershipRecord" });
export type OrganizationMembershipRecord = z.output<typeof organizationMembershipRecordSchema>;

/**
 * How the calling user acts in the current organization: as one of its members, or through the
 * organization managing it, whose members act in it with their role there, owners as admins,
 * without becoming its members.
 */
export const organizationAccessRecordSchema = z
  .lazy(() =>
    organizationMembershipRecordSchema._zod.innerType
      .extend({
        managingOrganization: z
          .strictObject({
            organizationId: z.string().min(1),
            name: z.string().min(1),
            slug: z.string().min(1),
          })
          .nullable()
          .describe("The organization managing this one, or null when none does."),
        through: z
          .enum(["membership", "managing-organization"])
          .describe(
            "Whether you act here as a member, or as a member of the managing organization. A member of both acts as a member.",
          ),
      })
      .refine(
        ({ managingOrganization, through }) =>
          through === "membership" || managingOrganization !== null,
        "Only a managed organization is reached through its managing organization.",
      ),
  )
  .meta({ id: "OrganizationAccessRecord" });
export type OrganizationAccessRecord = z.output<typeof organizationAccessRecordSchema>;

const organizationMemberRecordSchema = z
  .lazy(() =>
    z.strictObject({
      userId: z.string().min(1),
      name: z.string(),
      email: z.string().min(1),
      roles: z.array(z.string().min(1)).min(1),
      joinedAt: z.iso.datetime(),
    }),
  )
  .meta({ id: "OrganizationMemberRecord" });

export const organizationMemberPageSchema = z
  .lazy(() =>
    z.strictObject({
      members: z.array(organizationMemberRecordSchema),
      nextCursor: z.string().nullable(),
      hasNextPage: z.boolean(),
    }),
  )
  .meta({ id: "OrganizationMemberPage" });
export type OrganizationMemberPage = z.output<typeof organizationMemberPageSchema>;

/** Only unexpired pending invitations are listed; accepted or expired ones are history. */
export const organizationInvitationRecordSchema = z
  .lazy(() =>
    z.strictObject({
      invitationId: z.string().min(1),
      organizationId: z.string().min(1),
      email: z.string().min(1),
      roles: z.array(z.string().min(1)).min(1),
      expiresAt: z.iso.datetime(),
      createdAt: z.iso.datetime(),
    }),
  )
  .meta({ id: "OrganizationInvitationRecord" });
export type OrganizationInvitationRecord = z.output<typeof organizationInvitationRecordSchema>;

/** Invitations are not emailed; the inviter shares this link. */
const organizationInvitationLinkSchema = z
  .lazy(() => organizationInvitationRecordSchema._zod.innerType.extend({ url: z.url() }))
  .meta({ id: "OrganizationInvitationLink" });
export type OrganizationInvitationLink = z.output<typeof organizationInvitationLinkSchema>;

const organizationInvitationLinkPageSchema = z
  .lazy(() =>
    z.strictObject({
      invitations: z.array(organizationInvitationLinkSchema),
      nextCursor: z.string().nullable(),
      hasNextPage: z.boolean(),
    }),
  )
  .meta({ id: "OrganizationInvitationLinkPage" });
export type OrganizationInvitationLinkPage = z.output<typeof organizationInvitationLinkPageSchema>;

/** Organization operations act on the scoped organization as the calling user. */
export const organizationOperations = {
  "org.get": {
    description:
      "Read the current organization, your roles in it, and whether you act here as a member or through the organization managing it. List every organization you belong to with account.orgs.list.",
    permissions: [BACKOFFICE_PERMISSION.org.read],
    input: z.void(),
    output: organizationAccessRecordSchema,
  },
  "org.update": {
    description: "Rename the current organization. Requires the owner or admin role.",
    permissions: [BACKOFFICE_PERMISSION.org.manage],
    input: z.lazy(() => z.strictObject({ name: z.string().trim().min(1) })),
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
    input: z.lazy(() =>
      z.strictObject({
        email: z.string().trim().toLowerCase().pipe(z.email()),
        roles: z.array(organizationRoleSchema).min(1),
      }),
    ),
    output: organizationInvitationLinkSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
