import {
  type AppInstallationResourceScope,
  type BackofficeAppInstallation,
  type BackofficeAppInstallationAccessInput,
  type BackofficeAppInstallationMutationResult,
  type BackofficeAppInstallationPage,
  type BackofficeAppInstallationPageInput,
  appInstallationAccessSchema,
  appInstallationExternalAccountSchema,
  backofficeAppInstallationSchema,
} from "@fragno-dev/backoffice-api/v0/apps";
import {
  backofficeAppLookupInputSchema,
  type BackofficeAppLookupInput,
} from "@fragno-dev/backoffice-api/v0/apps";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import type { BackofficeAppOperationResult } from "@/fragno/apps/errors";

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

/** Organization ownership comes from the object scope, never an RPC payload. */
export const backofficeAppInstallationInputSchema = backofficeAppLookupInputSchema
  .extend(appInstallationAccessSchema.shape)
  .extend({ installedByUserId: z.string().min(1).max(191) });
export type BackofficeAppInstallationInput = z.infer<typeof backofficeAppInstallationInputSchema>;

/** Binds the app's own tenant to one activation; only the authenticated app server may claim. */
export const backofficeAppInstallationClaimInputSchema = backofficeAppLookupInputSchema.extend({
  activation: z.number().int().positive(),
  externalAccount: appInstallationExternalAccountSchema,
});
export type BackofficeAppInstallationClaimInput = z.infer<
  typeof backofficeAppInstallationClaimInputSchema
>;

/** Uninstalled records retain their identity, but hold no effective grants. */
export type BackofficeAppInstallationStatus = BackofficeAppInstallation["status"];

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
