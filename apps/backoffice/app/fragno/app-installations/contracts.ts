import { z } from "zod";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import {
  backofficeAppLookupInputSchema,
  type BackofficeAppLookupInput,
} from "@/fragno/apps/contracts";
import type { BackofficeAppOperationResult } from "@/fragno/apps/errors";
import { appPermissionsSchema } from "@/fragno/apps/permissions";

/**
 * The organization resources an installation may act on. Project lists are sets; they are
 * normalized so equal selections compare equal regardless of order.
 */
export const appInstallationResourceScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("organization") }),
  z.strictObject({
    kind: z.literal("projects"),
    projectIds: z
      .array(z.string().trim().min(1).max(191))
      .min(1)
      .max(100)
      .transform((projectIds) => [...new Set(projectIds)].sort()),
  }),
]);
export type AppInstallationResourceScope = z.infer<typeof appInstallationResourceScopeSchema>;

/** The one installation resource policy, shared by credential issuance and live authorization. */
export function appInstallationResourceScopeContains(
  resourceScope: AppInstallationResourceScope,
  scope: Extract<BackofficeContextScope, { kind: "org" | "project" }>,
): boolean {
  return (
    resourceScope.kind === "organization" ||
    (scope.kind === "project" && resourceScope.projectIds.includes(scope.projectId))
  );
}

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

/** Organization ownership comes from the object scope, never an RPC payload. */
export const backofficeAppInstallationInputSchema = backofficeAppLookupInputSchema
  .extend(appInstallationAccessSchema.shape)
  .extend({ installedByUserId: z.string().min(1).max(191) });
export type BackofficeAppInstallationInput = z.infer<typeof backofficeAppInstallationInputSchema>;

/** Access changes are explicit control-plane operations and cannot change organization ownership. */
export const backofficeAppInstallationAccessInputSchema = backofficeAppLookupInputSchema.extend(
  appInstallationAccessSchema.shape,
);
export type BackofficeAppInstallationAccessInput = z.infer<
  typeof backofficeAppInstallationAccessInputSchema
>;

/** Binds the app's own tenant to one activation; only the authenticated app server may claim. */
export const backofficeAppInstallationClaimInputSchema = backofficeAppLookupInputSchema.extend({
  activation: z.number().int().positive(),
  externalAccount: appInstallationExternalAccountSchema,
});
export type BackofficeAppInstallationClaimInput = z.infer<
  typeof backofficeAppInstallationClaimInputSchema
>;

/** Cursors remain bound to the owning organization even when each object has its own database. */
export const backofficeAppInstallationPageInputSchema = z.strictObject({
  pageSize: z.number().int().min(1).max(100),
  cursor: z.string().min(1).nullable(),
});
export type BackofficeAppInstallationPageInput = z.infer<
  typeof backofficeAppInstallationPageInputSchema
>;

/** Uninstalled records retain their identity, but hold no effective grants. */
export type BackofficeAppInstallationStatus = BackofficeAppInstallation["status"];

/** Installation authority belongs to the customer organization, not the installing user. */
export const backofficeAppInstallationSchema = z.strictObject({
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
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type BackofficeAppInstallation = z.infer<typeof backofficeAppInstallationSchema>;

/** Reinstallation preserves the transaction-resolved installation identity. */
export const backofficeAppInstallationMutationResultSchema = z.strictObject({
  installationId: z.string().min(1),
  changed: z.boolean(),
});
export type BackofficeAppInstallationMutationResult = z.infer<
  typeof backofficeAppInstallationMutationResultSchema
>;

/** What the app learns about the installation it claimed; never credentials or installer identity. */
export const backofficeAppInstallationClaimResultSchema = backofficeAppInstallationSchema.pick({
  id: true,
  appId: true,
  organizationId: true,
  grantedPermissions: true,
  resourceScope: true,
  externalAccount: true,
  activation: true,
});
export type BackofficeAppInstallationClaimResult = z.infer<
  typeof backofficeAppInstallationClaimResultSchema
>;

/** Organization installation history includes uninstalled records. */
export const backofficeAppInstallationPageSchema = z.strictObject({
  installations: z.array(backofficeAppInstallationSchema),
  nextCursor: z.string().nullable(),
  hasNextPage: z.boolean(),
});
export type BackofficeAppInstallationPage = z.infer<typeof backofficeAppInstallationPageSchema>;

/** Internal organization-scoped commands; callers must establish Auth management authority. */
export type BackofficeAppInstallationsCommands = {
  installApp(
    input: BackofficeAppInstallationInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppInstallationMutationResult>>;
  getInstallation(input: BackofficeAppLookupInput): Promise<BackofficeAppInstallation | null>;
  listInstallations(
    input: BackofficeAppInstallationPageInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppInstallationPage>>;
  updateInstallationAccess(
    input: BackofficeAppInstallationAccessInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppInstallationMutationResult>>;
  claimInstallation(
    input: BackofficeAppInstallationClaimInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppInstallationClaimResult>>;
  uninstallApp(
    input: BackofficeAppLookupInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppInstallationMutationResult>>;
};
