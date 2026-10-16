import type {
  AppActionRequest,
  AppActionTokenClaims,
} from "@fragno-dev/backoffice-api/v0/app-actions";
import {
  type AppActionsDeclaration,
  type AppInstallationResourceScope,
  type BackofficeApp,
  type BackofficeAppInstallation,
  type BackofficeAppInstallationAccessInput,
  type BackofficeAppInstallationActionsApprovalInput,
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
import type { JsonValue } from "@fragno-dev/backoffice-api/v0/shared/json";
import type {
  BackofficeContextScope,
  BackofficeOrganizationScope,
  BackofficeScopeIdNames,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import type { BackofficeAppOperationResult } from "@/fragno/apps/errors";

type OrganizationScope = BackofficeOrganizationScope<BackofficeScopeIdNames>;
type OrganizationAppScope = { kind: "app"; owner: OrganizationScope; appId: string };

/**
 * Where an organization's installation can act: the organization and the projects it owns directly,
 * as approved, and an app's own workspace with its projects. Other owners' projects can share a
 * project ID, so the owner is part of the target.
 */
export type AppInstallationTargetScope =
  | OrganizationScope
  | OrganizationAppScope
  | {
      kind: "project";
      owner: OrganizationScope | OrganizationAppScope;
      projectId: string;
    };

/** Narrows a scope to an installation target, or `null` where installations never act. */
export function appInstallationTargetScope(
  scope: BackofficeContextScope,
): AppInstallationTargetScope | null {
  switch (scope.kind) {
    case "org":
      return scope;
    case "app":
      return scope.owner.kind === "org"
        ? { kind: "app", owner: scope.owner, appId: scope.appId }
        : null;
    case "project": {
      // An owner is never a project, which the narrowed type cannot express.
      const owner = appInstallationTargetScope(scope.owner);
      return owner && owner.kind !== "project"
        ? { kind: "project", owner, projectId: scope.projectId }
        : null;
    }
    case "system":
    case "user":
      return null;
    default:
      throw new Error("Unsupported Backoffice scope kind.", { cause: scope satisfies never });
  }
}

/**
 * The one installation reach policy, shared by credential issuance and live authorization. An app's
 * own workspace is always within reach; the organization's resources only as approved.
 */
export function appInstallationReaches(
  installation: { appId: string; resourceScope: AppInstallationResourceScope },
  target: AppInstallationTargetScope,
): boolean {
  const workspace = target.kind === "project" ? target.owner : target;
  if (workspace.kind === "app") {
    return workspace.appId === installation.appId;
  }
  return (
    installation.resourceScope.kind === "organization" ||
    (target.kind === "project" && installation.resourceScope.projectIds.includes(target.projectId))
  );
}

/** Organization ownership comes from the object scope, never an RPC payload. */
export const backofficeAppInstallationInputSchema = backofficeAppLookupInputSchema
  .extend(appInstallationAccessSchema.shape)
  .extend({
    installedByUserId: z.string().min(1).max(191),
    actionsRevision: z.number().int().positive(),
  });
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

/** One approved revision of an app's action declaration, kept on the installation. */
export type AppApprovedActions = { revision: number; declaration: AppActionsDeclaration };

/**
 * What an installation may call now. With installation approval that is the approved snapshot, and
 * a newer registry revision waits for approval; automatic declarations apply as soon as they change.
 */
export function effectiveAppActions(
  app: Pick<BackofficeApp, "actions" | "actionsRevision">,
  approved: AppApprovedActions | null,
): { actions: AppActionsDeclaration; pendingActionsRevision: number | null } {
  if (app.actions.kind === "endpoint" && app.actions.changeApproval === "automatic") {
    return { actions: app.actions, pendingActionsRevision: null };
  }
  const approvedRevision = approved?.revision ?? 0;
  return {
    actions: approved?.declaration ?? { kind: "none" },
    pendingActionsRevision: app.actionsRevision === approvedRevision ? null : app.actionsRevision,
  };
}

/** An active installation joined with its app's registration and the actions it may call. */
export type BackofficeAppConnection =
  | { status: "not-installed" }
  | {
      status: "installed";
      app: BackofficeApp;
      installation: BackofficeAppInstallation;
      actions: AppActionsDeclaration;
      pendingActionsRevision: number | null;
    };

/** Backoffice's identity claims for one call; the installation object adds the rest. */
export type AppEndpointCallInput = {
  appId: string;
  scopeRestriction: AppInstallationTargetScope;
  actor: AppActionTokenClaims["actor"];
  request: AppActionRequest;
};

/** The app's own answer; a body that is not JSON is null. */
export type AppEndpointResponse = { status: number; body: JsonValue | null };

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
  approveActions(
    input: BackofficeAppInstallationActionsApprovalInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppInstallationMutationResult>>;
  getAppConnection(input: BackofficeAppLookupInput): Promise<BackofficeAppConnection>;
  /** Signs and sends one request to the app's endpoint; only approved actions are sent. */
  callAppEndpoint(
    input: AppEndpointCallInput,
  ): Promise<BackofficeAppOperationResult<AppEndpointResponse>>;
  uninstallApp(
    input: BackofficeAppLookupInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppInstallationMutationResult>>;
};
