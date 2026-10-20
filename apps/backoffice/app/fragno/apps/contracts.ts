import {
  type BackofficeApp,
  type BackofficeAppLookupInput,
  backofficeAppSchema,
} from "@fragno-dev/backoffice-api/v0/apps";
import {
  appActionsDeclarationSchema,
  appPermissionsSchema,
  appSlugSchema,
  appTrustSchema,
  backofficeAppLookupInputSchema,
} from "@fragno-dev/backoffice-api/v0/apps";
import { z } from "zod";

import type { BackofficeAppOperationResult } from "./errors";

/** Registers an already-provisioned OAuth client; Auth owns its identity and metadata. */
export const backofficeAppRegistrationInputSchema = z.strictObject({
  slug: appSlugSchema,
  oauthClientId: z.string().min(1).max(191),
  requestedPermissions: appPermissionsSchema,
  actions: appActionsDeclarationSchema,
  trust: appTrustSchema,
});
export type BackofficeAppRegistrationInput = z.infer<typeof backofficeAppRegistrationInputSchema>;

/** Replaces an app's action declaration; installations approve the new revision unless automatic. */
export const backofficeAppActionsUpdateInputSchema = z.lazy(() =>
  backofficeAppLookupInputSchema._zod.innerType.extend({ actions: appActionsDeclarationSchema }),
);
export type BackofficeAppActionsUpdateInput = z.infer<typeof backofficeAppActionsUpdateInputSchema>;

/** An unchanged declaration keeps its revision, so repeating an update needs no new approval. */
export const backofficeAppActionsUpdateResultSchema = z.strictObject({
  actionsRevision: z.number().int().positive(),
  changed: z.boolean(),
});
export type BackofficeAppActionsUpdateResult = z.infer<
  typeof backofficeAppActionsUpdateResultSchema
>;

/**
 * Replaces what an app asks installations for. Installations keep the grants their owner approved:
 * an added permission applies once an owner grants it, and a removed one stays granted until an
 * owner changes the installation's access.
 */
export const backofficeAppPermissionsUpdateInputSchema = z.lazy(() =>
  backofficeAppLookupInputSchema._zod.innerType.extend({
    requestedPermissions: appPermissionsSchema,
  }),
);
export type BackofficeAppPermissionsUpdateInput = z.infer<
  typeof backofficeAppPermissionsUpdateInputSchema
>;

export const backofficeAppPermissionsUpdateResultSchema = z.strictObject({ changed: z.boolean() });
export type BackofficeAppPermissionsUpdateResult = z.infer<
  typeof backofficeAppPermissionsUpdateResultSchema
>;

/** Trust is set in place, like actions and requested permissions. */
export const backofficeAppTrustUpdateInputSchema = z.lazy(() =>
  backofficeAppLookupInputSchema._zod.innerType.extend({ trust: appTrustSchema }),
);
export type BackofficeAppTrustUpdateInput = z.infer<typeof backofficeAppTrustUpdateInputSchema>;

export const backofficeAppTrustUpdateResultSchema = z.strictObject({ changed: z.boolean() });
export type BackofficeAppTrustUpdateResult = z.infer<typeof backofficeAppTrustUpdateResultSchema>;

/** Auth resolves the app behind a verified OAuth client; the client ID is never caller-chosen. */
export const backofficeAppOAuthClientLookupInputSchema = z.strictObject({
  oauthClientId: z.string().min(1).max(191),
});
export type BackofficeAppOAuthClientLookupInput = z.infer<
  typeof backofficeAppOAuthClientLookupInputSchema
>;

/** Integration addresses name apps by slug; the registry resolves it to the app. */
export const backofficeAppSlugLookupInputSchema = z.strictObject({ slug: appSlugSchema });
export type BackofficeAppSlugLookupInput = z.infer<typeof backofficeAppSlugLookupInputSchema>;

/** Registration returns the transaction-resolved identity, not unresolved database timestamps. */
export const backofficeAppRegistrationResultSchema = z.strictObject({
  appId: z.string().min(1),
  created: z.boolean(),
});
export type BackofficeAppRegistrationResult = z.infer<typeof backofficeAppRegistrationResultSchema>;

/** Registry pagination is ascending by app identity, with an explicit bounded page size. */
export const backofficeAppPageInputSchema = z.strictObject({
  pageSize: z.number().int().min(1).max(100),
  cursor: z.string().min(1).nullable(),
});
export type BackofficeAppPageInput = z.infer<typeof backofficeAppPageInputSchema>;

/** App listings contain registrations, never OAuth credentials or organization grants. */
export const backofficeAppPageSchema = z.strictObject({
  apps: z.array(backofficeAppSchema),
  nextCursor: z.string().nullable(),
  hasNextPage: z.boolean(),
});
export type BackofficeAppPage = z.infer<typeof backofficeAppPageSchema>;

/** Singleton registry commands; callers must establish Auth identity and publisher authority. */
export type BackofficeAppsCommands = {
  registerApp(
    input: BackofficeAppRegistrationInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppRegistrationResult>>;
  updateAppActions(
    input: BackofficeAppActionsUpdateInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppActionsUpdateResult>>;
  updateAppPermissions(
    input: BackofficeAppPermissionsUpdateInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppPermissionsUpdateResult>>;
  updateAppTrust(
    input: BackofficeAppTrustUpdateInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppTrustUpdateResult>>;
  /** Auth hides and protects the OAuth consents of these clients. */
  listFirstPartyOAuthClientIds(): Promise<string[]>;
  getApp(input: BackofficeAppLookupInput): Promise<BackofficeApp | null>;
  getAppByOAuthClientId(input: BackofficeAppOAuthClientLookupInput): Promise<BackofficeApp | null>;
  getAppBySlug(input: BackofficeAppSlugLookupInput): Promise<BackofficeApp | null>;
  listApps(input: BackofficeAppPageInput): Promise<BackofficeAppOperationResult<BackofficeAppPage>>;
};
