import { z } from "zod";

import type { BackofficeAppOperationResult } from "./errors";
import { appPermissionsSchema } from "./permissions";

/** Registers an already-provisioned OAuth client; Auth owns its identity and metadata. */
export const backofficeAppRegistrationInputSchema = z.strictObject({
  oauthClientId: z.string().min(1).max(191),
  requestedPermissions: appPermissionsSchema,
});
export type BackofficeAppRegistrationInput = z.infer<typeof backofficeAppRegistrationInputSchema>;

/** App identity is global; an organization installation refers to the same registry ID. */
export const backofficeAppLookupInputSchema = z.strictObject({ appId: z.string().min(1).max(191) });
export type BackofficeAppLookupInput = z.infer<typeof backofficeAppLookupInputSchema>;

/** Auth resolves the app behind a verified OAuth client; the client ID is never caller-chosen. */
export const backofficeAppOAuthClientLookupInputSchema = z.strictObject({
  oauthClientId: z.string().min(1).max(191),
});
export type BackofficeAppOAuthClientLookupInput = z.infer<
  typeof backofficeAppOAuthClientLookupInputSchema
>;

/** Backoffice-specific registration data; OAuth metadata remains authoritative in Auth. */
export const backofficeAppSchema = z.strictObject({
  id: z.string().min(1),
  oauthClientId: z.string().min(1),
  requestedPermissions: appPermissionsSchema,
  createdAt: z.iso.datetime(),
});
export type BackofficeApp = z.infer<typeof backofficeAppSchema>;

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
  getApp(input: BackofficeAppLookupInput): Promise<BackofficeApp | null>;
  getAppByOAuthClientId(input: BackofficeAppOAuthClientLookupInput): Promise<BackofficeApp | null>;
  listApps(input: BackofficeAppPageInput): Promise<BackofficeAppOperationResult<BackofficeAppPage>>;
};
