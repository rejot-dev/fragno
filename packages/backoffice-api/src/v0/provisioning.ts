import { z } from "zod";

import { organizationMembershipRecordSchema } from "./organization";

/**
 * Each provisioning operation is its own permission, so an administrator grants a first-party app
 * only the operations it needs.
 */
export const backofficeProvisioningPermissionSchema = z.lazy(() =>
  z.enum(["organizations.provision", "projects.provision", "invitations.accept"]),
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
      created: z.boolean(),
    }),
  )
  .meta({ id: "ProvisionOrganizationResult" });
export type ProvisionOrganizationResult = z.output<typeof provisionOrganizationResultSchema>;

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

export const acceptInvitationInputSchema = z
  .lazy(() =>
    z.strictObject({
      invitationId: z
        .string()
        .trim()
        .min(1)
        .describe(
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
  "projects.provision": {
    description:
      "Create a project in an organization where the app is installed, on behalf of a member who authorized the app.",
    permission: "projects.provision",
    input: provisionProjectInputSchema,
    output: provisionProjectResultSchema,
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
