import { z } from "zod";

import { organizationRoleSchema } from "./organization";

/**
 * Each provisioning operation is its own permission, so an administrator grants a first-party app
 * only the operations it needs.
 */
export const backofficeProvisioningPermissionSchema = z.lazy(() =>
  z.enum([
    "users.provision",
    "organizations.provision",
    "projects.provision",
    "organizations.members.sync",
  ]),
);
export type BackofficeProvisioningPermission = z.output<
  typeof backofficeProvisioningPermissionSchema
>;

/** An identifier in the calling app; provisioning the same one again returns what it made. */
const externalIdSchema = z.lazy(() => z.string().trim().min(1).max(191));

const userIdSchema = z.lazy(() =>
  z
    .string()
    .min(1)
    .max(191)
    .describe(
      "A Backoffice user linked to the app: one it provisioned, or one who authorized it with OAuth.",
    ),
);

export const provisionUserInputSchema = z
  .lazy(() =>
    z.strictObject({
      externalUserId: externalIdSchema,
      email: z
        .string()
        .trim()
        .toLowerCase()
        .pipe(z.email())
        .describe(
          "Must be verified by the app: Backoffice trusts it and creates the user with a verified address.",
        ),
      name: z.string().trim().min(1).max(191),
    }),
  )
  .meta({ id: "ProvisionUserInput" });
export type ProvisionUserInput = z.output<typeof provisionUserInputSchema>;

export const provisionUserResultSchema = z
  .lazy(() =>
    z.discriminatedUnion("status", [
      z.strictObject({
        status: z.literal("provisioned"),
        userId: z.string().min(1),
        created: z.boolean(),
      }),
      // Another account holds the address. Taking it over would hand that account to the app, so
      // its owner links it by authorizing the app with OAuth instead.
      z.strictObject({ status: z.literal("requires_link") }),
    ]),
  )
  .meta({ id: "ProvisionUserResult" });
export type ProvisionUserResult = z.output<typeof provisionUserResultSchema>;

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
      externalOrganizationId: externalIdSchema.describe(
        "An organization this app provisioned; the project is created there.",
      ),
      externalProjectId: externalIdSchema,
      name: z.string().trim().min(1).max(160),
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

export const syncOrganizationMembersInputSchema = z
  .lazy(() =>
    z.strictObject({
      externalOrganizationId: externalIdSchema,
      members: z
        .array(z.strictObject({ userId: userIdSchema, role: organizationRoleSchema }))
        .max(1000)
        .refine(
          (members) => new Set(members.map(({ userId }) => userId)).size === members.length,
          "Each user is listed once.",
        ),
    }),
  )
  .meta({ id: "SyncOrganizationMembersInput" });
export type SyncOrganizationMembersInput = z.output<typeof syncOrganizationMembersInputSchema>;

export const syncOrganizationMembersResultSchema = z
  .lazy(() =>
    z.strictObject({
      added: z.array(z.string()),
      updated: z.array(z.string()),
      removed: z.array(z.string()),
    }),
  )
  .meta({ id: "SyncOrganizationMembersResult" });
export type SyncOrganizationMembersResult = z.output<typeof syncOrganizationMembersResultSchema>;

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
 * Lets a first-party app mirror its own tenants in Backoffice. Each operation is
 * `POST /api/v0/provisioning/<operationId>` with the app's client-credentials token, and is
 * idempotent on the app's identifiers.
 */
export const backofficeProvisioningOperations = {
  "users.provision": {
    description:
      "Create a Backoffice user for one of the app's users, without a password. Returns requires_link when another account already has the address.",
    permission: "users.provision",
    input: provisionUserInputSchema,
    output: provisionUserResultSchema,
  },
  "organizations.provision": {
    description:
      "Create a Backoffice organization for one of the app's organizations, owned by a linked user, and install the app there with every permission it requests, linked to that organization.",
    permission: "organizations.provision",
    input: provisionOrganizationInputSchema,
    output: provisionOrganizationResultSchema,
  },
  "projects.provision": {
    description: "Create a project in an organization the app provisioned.",
    permission: "projects.provision",
    input: provisionProjectInputSchema,
    output: provisionProjectResultSchema,
  },
  "organizations.members.sync": {
    description:
      "Make the members linked to the app exactly those listed, with their roles. Members the app is not linked to keep their membership, and the organization keeps an owner.",
    permission: "organizations.members.sync",
    input: syncOrganizationMembersInputSchema,
    output: syncOrganizationMembersResultSchema,
  },
} as const satisfies Record<BackofficeProvisioningPermission, BackofficeProvisioningOperation>;
export type BackofficeProvisioningOperationId = keyof typeof backofficeProvisioningOperations;
