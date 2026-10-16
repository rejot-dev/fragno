import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";
import { backofficePermissionRequirementSchema } from "./shared/permissions";

/** App permission declarations and grants are sets; duplicate entries are malformed input. */
export const appPermissionsSchema = z
  .array(backofficePermissionRequirementSchema)
  .refine(
    (permissions) =>
      new Set(permissions.map(({ namespace, permission }) => `${namespace}.${permission}`)).size ===
      permissions.length,
    "Backoffice app permissions must not contain duplicates.",
  );

/** App identity is global; an organization installation refers to the same registry ID. */
export const backofficeAppLookupInputSchema = z.strictObject({ appId: z.string().min(1).max(191) });
export type BackofficeAppLookupInput = z.infer<typeof backofficeAppLookupInputSchema>;

/** Addresses outlive the registration's other fields, so a slug never changes once chosen. */
export const appSlugSchema = z
  .string()
  .max(63)
  .regex(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
    "App slugs are lowercase words separated by '-', e.g. bookkeeping.",
  )
  .describe(
    "Unique, permanent name for the app; its integration connection is app#<slug>, e.g. app#bookkeeping.",
  );

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** One operation an app serves on its own server, called through the app's integration connection. */
export const appActionSchema = z
  .strictObject({
    id: z
      .string()
      .max(100)
      .regex(
        /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/,
        "App action IDs are lowercase words separated by '.', '-', or '_', e.g. invoices.list.",
      ),
    label: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(1000),
    inputSchema: z
      .record(z.string(), z.unknown())
      .describe("JSON Schema (2020-12 or draft-07) for the action's object input."),
    outputSchema: z
      .record(z.string(), z.unknown())
      .describe("JSON Schema (2020-12 or draft-07) for the action's result."),
  })
  .meta({ id: "AppAction" });
export type AppAction = z.infer<typeof appActionSchema>;

/**
 * What an app lets Backoffice call. Each installation approves one revision of it; with
 * `changeApproval: "automatic"`, later revisions apply to every installation without approval.
 */
export const appActionsDeclarationSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("none") }),
    z.strictObject({
      kind: z.literal("endpoint"),
      endpointUrl: z
        .url({ protocol: /^https?$/ })
        .refine(
          (url) => url.startsWith("https:") || LOOPBACK_HOSTNAMES.has(new URL(url).hostname),
          "App action endpoints use HTTPS; plain HTTP is allowed only on loopback for development.",
        )
        .describe(
          "Receives each signed action request as a POST; the request token's audience is this URL.",
        ),
      changeApproval: z
        .enum(["installation", "automatic"])
        .describe(
          "installation: each installation approves a changed declaration before new or changed actions run. automatic: changes apply immediately; only administrators register apps, so reserve it for apps they operate.",
        ),
      actions: z
        .array(appActionSchema)
        .min(1)
        .max(100)
        .refine(
          (actions) => new Set(actions.map(({ id }) => id)).size === actions.length,
          "App action IDs must be unique.",
        ),
    }),
  ])
  .meta({ id: "AppActionsDeclaration" });
export type AppActionsDeclaration = z.infer<typeof appActionsDeclarationSchema>;

const appActionsRevisionSchema = z
  .number()
  .int()
  .positive()
  .describe("Increments whenever the app's action declaration changes.");

/** Backoffice-specific registration data; OAuth metadata remains authoritative in Auth. */
export const backofficeAppSchema = z
  .strictObject({
    id: z.string().min(1),
    slug: appSlugSchema,
    oauthClientId: z.string().min(1),
    requestedPermissions: appPermissionsSchema,
    actions: appActionsDeclarationSchema,
    actionsRevision: appActionsRevisionSchema,
    createdAt: z.iso.datetime(),
  })
  .meta({ id: "BackofficeApp" });
export type BackofficeApp = z.infer<typeof backofficeAppSchema>;

/**
 * The organization resources an installation may act on. Project lists are sets; they are
 * normalized so equal selections compare equal regardless of order.
 */
const appInstallationResourceScopeSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("organization") }),
    z.strictObject({
      kind: z.literal("projects"),
      // Piping into an array schema keeps the normalized form describable as JSON Schema.
      projectIds: z
        .array(z.string().trim().min(1).max(191))
        .min(1)
        .max(100)
        .transform((projectIds) => [...new Set(projectIds)].sort())
        .pipe(z.array(z.string())),
    }),
  ])
  .meta({ id: "AppInstallationResourceScope" });
export type AppInstallationResourceScope = z.infer<typeof appInstallationResourceScopeSchema>;

/** What an organization approves: permissions, and the resources they apply to. */
export const appInstallationAccessSchema = z.strictObject({
  grantedPermissions: appPermissionsSchema,
  resourceScope: appInstallationResourceScopeSchema,
});

/** An app-side tenant, such as a Bookkeeping organization, claimed by the app's server. */
export const appInstallationExternalAccountSchema = z.strictObject({
  id: z.string().trim().min(1).max(191),
  label: z.string().trim().min(1).max(191),
});
export type AppInstallationExternalAccount = z.infer<typeof appInstallationExternalAccountSchema>;

/** Access changes are explicit control-plane operations and cannot change organization ownership. */
export const backofficeAppInstallationAccessInputSchema = backofficeAppLookupInputSchema.extend(
  appInstallationAccessSchema.shape,
);
export type BackofficeAppInstallationAccessInput = z.infer<
  typeof backofficeAppInstallationAccessInputSchema
>;

/** Installing approves access and, at the reviewed revision, the app's declared actions. */
export const backofficeAppInstallInputSchema = backofficeAppInstallationAccessInputSchema.extend({
  resourceScope: appInstallationResourceScopeSchema.default({ kind: "organization" }),
  actionsRevision: appActionsRevisionSchema.describe(
    "The actionsRevision reviewed with apps.get; installation fails if the declaration changed since.",
  ),
});
export type BackofficeAppInstallInput = z.output<typeof backofficeAppInstallInputSchema>;

/** Approval names the reviewed revision, so a declaration changed since review is never approved. */
export const backofficeAppInstallationActionsApprovalInputSchema =
  backofficeAppLookupInputSchema.extend({
    actionsRevision: appActionsRevisionSchema.describe(
      "The actionsRevision reviewed with apps.get; approval fails if the declaration changed since.",
    ),
  });
export type BackofficeAppInstallationActionsApprovalInput = z.infer<
  typeof backofficeAppInstallationActionsApprovalInputSchema
>;

/** Cursors remain bound to the owning organization even when each object has its own database. */
export const backofficeAppInstallationPageInputSchema = z.strictObject({
  pageSize: z.number().int().min(1).max(100),
  cursor: z.string().min(1).nullable(),
});
export type BackofficeAppInstallationPageInput = z.infer<
  typeof backofficeAppInstallationPageInputSchema
>;

/** Installation authority belongs to the customer organization, not the installing user. */
export const backofficeAppInstallationSchema = z
  .strictObject({
    id: z.string().min(1),
    appId: z.string().min(1),
    organizationId: z.string().min(1),
    grantedPermissions: appPermissionsSchema,
    resourceScope: appInstallationResourceScopeSchema,
    /** Null until the app's server claims the installation for one of its own tenants. */
    externalAccount: appInstallationExternalAccountSchema.nullable(),
    installedByUserId: z.string().min(1),
    status: z.enum(["active", "uninstalled"]),
    /** Increments on reinstallation; app credentials are bound to the activation that issued them. */
    activation: z.number().int().positive(),
    approvedActionsRevision: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "The app's actionsRevision this installation approved; 0 when it approved no declaration.",
      ),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: "BackofficeAppInstallation" });
export type BackofficeAppInstallation = z.infer<typeof backofficeAppInstallationSchema>;

/** Reinstallation preserves the transaction-resolved installation identity. */
export const backofficeAppInstallationMutationResultSchema = z
  .strictObject({
    installationId: z.string().min(1),
    changed: z.boolean(),
  })
  .meta({ id: "BackofficeAppInstallationMutationResult" });
export type BackofficeAppInstallationMutationResult = z.infer<
  typeof backofficeAppInstallationMutationResultSchema
>;

/** Organization installation history includes uninstalled records. */
export const backofficeAppInstallationPageSchema = z
  .strictObject({
    installations: z.array(backofficeAppInstallationSchema),
    nextCursor: z.string().nullable(),
    hasNextPage: z.boolean(),
  })
  .meta({ id: "BackofficeAppInstallationPage" });
export type BackofficeAppInstallationPage = z.infer<typeof backofficeAppInstallationPageSchema>;

/** App operations manage the scoped organization's installations as the calling user. */
export const appsOperations = {
  "apps.get": {
    description:
      "Review a registered app's requested permissions and declared actions before approving an installation.",
    permissions: [BACKOFFICE_PERMISSION.apps.read],
    input: backofficeAppLookupInputSchema,
    output: backofficeAppSchema.nullable(),
  },
  "apps.install": {
    description:
      "Approve an app installation in the selected organization, limited to explicit permissions and resources, and approve the app's declared actions at the reviewed revision. Installer identity comes from the authenticated user.",
    permissions: [BACKOFFICE_PERMISSION.apps.manage],
    input: backofficeAppInstallInputSchema,
    output: backofficeAppInstallationMutationResultSchema,
  },
  "apps.installations.get": {
    description:
      "Inspect one app installation in the selected organization, including approved grants.",
    permissions: [BACKOFFICE_PERMISSION.apps.read],
    input: backofficeAppLookupInputSchema,
    output: backofficeAppInstallationSchema.nullable(),
  },
  "apps.installations.list": {
    description:
      "List the selected organization's active and uninstalled apps using cursor pagination. Does not expose other organizations or OAuth credentials.",
    permissions: [BACKOFFICE_PERMISSION.apps.read],
    input: backofficeAppInstallationPageInputSchema.extend({
      pageSize: backofficeAppInstallationPageInputSchema.shape.pageSize.default(25),
      cursor: backofficeAppInstallationPageInputSchema.shape.cursor.default(null),
    }),
    output: backofficeAppInstallationPageSchema,
  },
  "apps.installations.update": {
    description:
      "Replace an active installation's approved permissions and resources. Takes effect immediately, including for issued app credentials. Does not change installer attribution.",
    permissions: [BACKOFFICE_PERMISSION.apps.manage],
    input: backofficeAppInstallationAccessInputSchema,
    output: backofficeAppInstallationMutationResultSchema,
  },
  "apps.installations.approveActions": {
    description:
      "Approve an app's current action declaration for the selected organization's installation, so its new and changed actions run. Only needed when the app's changeApproval is installation.",
    permissions: [BACKOFFICE_PERMISSION.apps.manage],
    input: backofficeAppInstallationActionsApprovalInputSchema,
    output: backofficeAppInstallationMutationResultSchema,
  },
  "apps.uninstall": {
    description:
      "Uninstall an app in the selected organization, clearing approved grants and its linked account while retaining installation identity. Immediately invalidates app credentials. Does not revoke personal OAuth consent.",
    permissions: [BACKOFFICE_PERMISSION.apps.manage],
    input: backofficeAppLookupInputSchema,
    output: backofficeAppInstallationMutationResultSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
