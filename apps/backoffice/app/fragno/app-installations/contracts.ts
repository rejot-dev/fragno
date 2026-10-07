import { z } from "zod";

import {
  backofficeAppLookupInputSchema,
  type BackofficeAppLookupInput,
} from "@/fragno/apps/contracts";
import type { BackofficeAppOperationResult } from "@/fragno/apps/errors";
import { appPermissionsSchema } from "@/fragno/apps/permissions";

/** Organization ownership comes from the object scope, never an RPC payload. */
export const backofficeAppInstallationInputSchema = backofficeAppLookupInputSchema.extend({
  grantedPermissions: appPermissionsSchema,
  installedByUserId: z.string().min(1).max(191),
});
export type BackofficeAppInstallationInput = z.infer<typeof backofficeAppInstallationInputSchema>;

/** Grant changes are explicit control-plane operations and cannot change organization ownership. */
export const backofficeAppInstallationGrantsInputSchema = backofficeAppLookupInputSchema.extend({
  grantedPermissions: appPermissionsSchema,
});
export type BackofficeAppInstallationGrantsInput = z.infer<
  typeof backofficeAppInstallationGrantsInputSchema
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
  installedByUserId: z.string().min(1),
  status: z.enum(["active", "uninstalled"]),
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
  updateInstallationGrants(
    input: BackofficeAppInstallationGrantsInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppInstallationMutationResult>>;
  uninstallApp(
    input: BackofficeAppLookupInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppInstallationMutationResult>>;
};
