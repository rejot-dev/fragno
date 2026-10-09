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

export const organizationInvitationPageSchema = z
  .strictObject({
    invitations: z.array(organizationInvitationRecordSchema),
    nextCursor: z.string().nullable(),
    hasNextPage: z.boolean(),
  })
  .meta({ id: "OrganizationInvitationPage" });
export type OrganizationInvitationPage = z.output<typeof organizationInvitationPageSchema>;
