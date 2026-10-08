import { z } from "zod";

/** Directory cursors are bound to one listing and page size; resume with the same page size. */
export const directoryPageInputSchema = z
  .strictObject({
    pageSize: z.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).nullable().default(null),
  })
  .meta({ id: "DirectoryPageInput" });
export type DirectoryPageInput = z.output<typeof directoryPageInputSchema>;

/** The signed-in user's own profile; it never describes another user. */
export const accountProfileSchema = z
  .strictObject({
    userId: z.string().min(1),
    name: z.string(),
    email: z.string().min(1),
    emailVerified: z.boolean(),
    systemRole: z.enum(["user", "admin"]),
  })
  .meta({ id: "AccountProfile" });
export type AccountProfile = z.output<typeof accountProfileSchema>;

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

export const organizationMemberRecordSchema = z
  .strictObject({
    userId: z.string().min(1),
    name: z.string(),
    email: z.string().min(1),
    roles: z.array(z.string().min(1)).min(1),
    joinedAt: z.iso.datetime(),
  })
  .meta({ id: "OrganizationMemberRecord" });
export type OrganizationMemberRecord = z.output<typeof organizationMemberRecordSchema>;

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

/** A pending invitation addressed to the signed-in user's email. */
export const accountInvitationRecordSchema = z
  .strictObject({
    invitationId: z.string().min(1),
    organization: organizationRecordSchema,
    roles: z.array(z.string().min(1)).min(1),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: "AccountInvitationRecord" });
export type AccountInvitationRecord = z.output<typeof accountInvitationRecordSchema>;

export const organizationPageSchema = z
  .strictObject({
    organizations: z.array(organizationRecordSchema),
    nextCursor: z.string().nullable(),
    hasNextPage: z.boolean(),
  })
  .meta({ id: "OrganizationPage" });
export type OrganizationPage = z.output<typeof organizationPageSchema>;

export const organizationMemberPageSchema = z
  .strictObject({
    members: z.array(organizationMemberRecordSchema),
    nextCursor: z.string().nullable(),
    hasNextPage: z.boolean(),
  })
  .meta({ id: "OrganizationMemberPage" });
export type OrganizationMemberPage = z.output<typeof organizationMemberPageSchema>;

export const organizationInvitationPageSchema = z
  .strictObject({
    invitations: z.array(organizationInvitationRecordSchema),
    nextCursor: z.string().nullable(),
    hasNextPage: z.boolean(),
  })
  .meta({ id: "OrganizationInvitationPage" });
export type OrganizationInvitationPage = z.output<typeof organizationInvitationPageSchema>;
