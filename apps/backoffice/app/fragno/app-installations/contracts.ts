import { z } from "zod";

import type { BackofficePermissionRequirement } from "@/backoffice-runtime/permissions";
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
export type BackofficeAppInstallationStatus = "active" | "uninstalled";

/** Installation authority belongs to the customer organization, not the installing user. */
export type BackofficeAppInstallation = {
  id: string;
  appId: string;
  organizationId: string;
  grantedPermissions: BackofficePermissionRequirement[];
  installedByUserId: string;
  status: BackofficeAppInstallationStatus;
  createdAt: string;
  updatedAt: string;
};

/** Reinstallation preserves the transaction-resolved installation identity. */
export type BackofficeAppInstallationMutationResult = { installationId: string; changed: boolean };

/** Organization installation history includes uninstalled records. */
export type BackofficeAppInstallationPage = {
  installations: BackofficeAppInstallation[];
  nextCursor: string | null;
  hasNextPage: boolean;
};

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
