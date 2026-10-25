import {
  organizationInvitationRecordSchema,
  organizationRecordSchema,
} from "@fragno-dev/backoffice-api/v0/organization";
import { z } from "zod";

export const organizationPageSchema = z
  .strictObject({
    organizations: z.array(organizationRecordSchema),
    nextCursor: z.string().nullable(),
    hasNextPage: z.boolean(),
  })
  .meta({ id: "OrganizationPage" });
export type OrganizationPage = z.output<typeof organizationPageSchema>;

/**
 * One numbered page of an organization's members for Backoffice's members page, with the Better Auth
 * member IDs its actions change membership by.
 */
export type OrganizationMemberNumberedPage = {
  members: Array<{
    memberId: string;
    userId: string;
    name: string;
    email: string;
    roles: string[];
    joinedAt: Date;
  }>;
  total: number;
};

export const organizationInvitationPageSchema = z
  .strictObject({
    invitations: z.array(organizationInvitationRecordSchema),
    nextCursor: z.string().nullable(),
    hasNextPage: z.boolean(),
  })
  .meta({ id: "OrganizationInvitationPage" });
export type OrganizationInvitationPage = z.output<typeof organizationInvitationPageSchema>;
