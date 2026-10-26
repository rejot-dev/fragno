import { z } from "zod";

import {
  organizationInvitationRecordSchema,
  organizationMembershipRecordSchema,
  organizationRoleSchema,
} from "./organization";
import { backofficeJurisdictionSchema } from "./shared/scope";

/**
 * Each provisioning operation is its own permission, so an administrator grants a first-party app
 * only the operations it needs.
 */
export const backofficeProvisioningPermissionSchema = z.lazy(() =>
  z.enum([
    "organizations.provision",
    "organizations.provisionForInvitee",
    "projects.provision",
    "invitations.create",
    "invitations.send",
    "invitations.accept",
  ]),
);
export type BackofficeProvisioningPermission = z.output<
  typeof backofficeProvisioningPermissionSchema
>;

/** An identifier in the calling app; provisioning the same one again returns what it made. */
const externalIdSchema = z.lazy(() => z.string().trim().min(1).max(191));

const userIdSchema = z.lazy(() =>
  z.string().min(1).max(191).describe("A Backoffice user who authorized the app with OAuth."),
);

export const provisionOrganizationInputSchema = z
  .lazy(() =>
    z.strictObject({
      externalOrganizationId: externalIdSchema,
      name: z.string().trim().min(1).max(191),
      ownerUserId: userIdSchema,
    }),
  )
  .meta({ id: "ProvisionOrganizationInput" });
export type ProvisionOrganizationInput = z.output<typeof provisionOrganizationInputSchema>;

export const provisionOrganizationResultSchema = z
  .lazy(() =>
    z.strictObject({
      organizationId: z.string().min(1),
      slug: z.string().min(1),
      // Scopes name the organization with it: `{ kind: "org", orgId, jurisdiction }`.
      jurisdiction: backofficeJurisdictionSchema.nullable(),
      created: z.boolean(),
    }),
  )
  .meta({ id: "ProvisionOrganizationResult" });
export type ProvisionOrganizationResult = z.output<typeof provisionOrganizationResultSchema>;

export const provisionOrganizationForInviteeInputSchema = z
  .lazy(() =>
    z.strictObject({
      externalOrganizationId: externalIdSchema,
      name: z.string().trim().min(1).max(191),
      ownerEmail: z
        .string()
        .trim()
        .toLowerCase()
        .pipe(z.email())
        .describe("Who is invited to own it; they need not have a Backoffice account yet."),
      invitedByUserId: userIdSchema.describe(
        "A user who authorized the app and invites the owner. They do not become a member.",
      ),
    }),
  )
  .meta({ id: "ProvisionOrganizationForInviteeInput" });
export type ProvisionOrganizationForInviteeInput = z.output<
  typeof provisionOrganizationForInviteeInputSchema
>;

export const provisionOrganizationForInviteeResultSchema = z
  .lazy(() =>
    z.strictObject({
      organizationId: z.string().min(1),
      slug: z.string().min(1),
      // Scopes name the organization with it: `{ kind: "org", orgId, jurisdiction }`.
      jurisdiction: backofficeJurisdictionSchema.nullable(),
      created: z.boolean(),
      ownerInvitation: z
        .strictObject({ invitationId: z.string().min(1), expiresAt: z.iso.datetime() })
        .nullable()
        .describe(
          "The pending owner invitation to send and accept; null once the organization has an owner.",
        ),
    }),
  )
  .meta({ id: "ProvisionOrganizationForInviteeResult" });
export type ProvisionOrganizationForInviteeResult = z.output<
  typeof provisionOrganizationForInviteeResultSchema
>;

export const provisionProjectInputSchema = z
  .lazy(() =>
    z.strictObject({
      organizationId: z
        .string()
        .trim()
        .min(1)
        .describe("An organization where the app is installed; the project is created there."),
      externalProjectId: externalIdSchema,
      name: z.string().trim().min(1).max(160),
      createdByUserId: userIdSchema.describe(
        "A member of the organization who authorized the app; the project is created as theirs.",
      ),
    }),
  )
  .meta({ id: "ProvisionProjectInput" });
export type ProvisionProjectInput = z.output<typeof provisionProjectInputSchema>;

export const provisionProjectResultSchema = z
  .lazy(() =>
    z.strictObject({
      organizationId: z.string().min(1),
      projectId: z.string().min(1),
      slug: z.string().min(1),
      created: z.boolean(),
    }),
  )
  .meta({ id: "ProvisionProjectResult" });
export type ProvisionProjectResult = z.output<typeof provisionProjectResultSchema>;

export const createInvitationInputSchema = z
  .lazy(() =>
    z.strictObject({
      organizationId: z
        .string()
        .trim()
        .min(1)
        .describe("An organization where the app is installed; the invitation is to it."),
      inviterUserId: userIdSchema.describe(
        "A member of the organization who authorized the app; the invitation is theirs, and their current role decides whom they may invite.",
      ),
      email: z.string().trim().toLowerCase().pipe(z.email()),
      roles: z.array(organizationRoleSchema).min(1),
    }),
  )
  .meta({ id: "CreateInvitationInput" });
export type CreateInvitationInput = z.output<typeof createInvitationInputSchema>;

const invitationIdSchema = z.lazy(() => z.string().trim().min(1));

export const sendInvitationInputSchema = z
  .lazy(() =>
    z.strictObject({
      invitationId: invitationIdSchema.describe(
        "A pending invitation to an organization where the app is installed.",
      ),
      url: z
        .url({ protocol: /^https?$/ })
        .describe(
          "The app's page where the invited person accepts it, on the origin of the app's home URL.",
        ),
    }),
  )
  .meta({ id: "SendInvitationInput" });
export type SendInvitationInput = z.output<typeof sendInvitationInputSchema>;

export const sendInvitationResultSchema = z
  .lazy(() =>
    z.strictObject({
      email: z.string().min(1).describe("The address the invitation was sent to."),
    }),
  )
  .meta({ id: "SendInvitationResult" });
export type SendInvitationResult = z.output<typeof sendInvitationResultSchema>;

export const acceptInvitationInputSchema = z
  .lazy(() =>
    z.strictObject({
      invitationId: invitationIdSchema.describe(
        "A pending invitation to an organization where the app is installed, addressed to the user's verified email.",
      ),
      userId: userIdSchema,
    }),
  )
  .meta({ id: "AcceptInvitationInput" });
export type AcceptInvitationInput = z.output<typeof acceptInvitationInputSchema>;

/** One provisioning operation and the permission an app needs to call it. */
export type BackofficeProvisioningOperation<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> = {
  description: string;
  permission: BackofficeProvisioningPermission;
  input: TInput;
  output: TOutput;
};

/**
 * Lets a first-party app create its tenants in Backoffice and bring its users into them. Each
 * operation is `POST /api/v0/provisioning/<operationId>` with the app's client-credentials token,
 * and is idempotent.
 */
export const backofficeProvisioningOperations = {
  "organizations.provision": {
    description:
      "Create a Backoffice organization for one of the app's organizations, owned by a user who authorized the app, and install the app there with every permission it requests, linked to that organization.",
    permission: "organizations.provision",
    input: provisionOrganizationInputSchema,
    output: provisionOrganizationResultSchema,
  },
  "organizations.provisionForInvitee": {
    description:
      "Create a Backoffice organization for one of the app's organizations, with no members and a pending owner invitation to an email address, from a user who authorized the app, and install the app there as organizations.provision does. Send and accept the invitation with invitations.send and invitations.accept. Provisioning it again returns the pending invitation, a new one once it expired, or none once the organization has an owner.",
    permission: "organizations.provisionForInvitee",
    input: provisionOrganizationForInviteeInputSchema,
    output: provisionOrganizationForInviteeResultSchema,
  },
  "projects.provision": {
    description:
      "Create a project in an organization where the app is installed, on behalf of a member who authorized the app.",
    permission: "projects.provision",
    input: provisionProjectInputSchema,
    output: provisionProjectResultSchema,
  },
  "invitations.create": {
    description:
      "Invite an email address to an organization where the app is installed, as a member who authorized the app. Owners and admins invite; only owners invite owners. Inviting the same address with the same roles again returns the pending invitation.",
    permission: "invitations.create",
    input: createInvitationInputSchema,
    output: organizationInvitationRecordSchema,
  },
  "invitations.send": {
    description:
      "Email a pending invitation to the address it is for, in the app's name, with a link to the app's page for accepting it. Sending it again sends nothing.",
    permission: "invitations.send",
    input: sendInvitationInputSchema,
    output: sendInvitationResultSchema,
  },
  "invitations.accept": {
    description:
      "Accept an organization invitation for the user it is addressed to, once they have signed in to the app. Accepting it again returns the same membership.",
    permission: "invitations.accept",
    input: acceptInvitationInputSchema,
    output: organizationMembershipRecordSchema,
  },
} as const satisfies Record<BackofficeProvisioningPermission, BackofficeProvisioningOperation>;
export type BackofficeProvisioningOperationId = keyof typeof backofficeProvisioningOperations;
