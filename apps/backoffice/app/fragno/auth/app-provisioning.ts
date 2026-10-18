import type { BackofficeApiErrorCode } from "@fragno-dev/backoffice-api/errors";
import type {
  ProvisionOrganizationInput,
  ProvisionOrganizationResult,
  ProvisionUserInput,
  ProvisionUserResult,
  SyncOrganizationMembersInput,
  SyncOrganizationMembersResult,
} from "@fragno-dev/backoffice-api/v0/provisioning";

/** Failures cross Durable Object RPC as values, coded as the provisioning API reports them. */
export type AppProvisioningResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        code: Extract<BackofficeApiErrorCode, "not_found" | "forbidden" | "conflict">;
        message: string;
      };
    };

/**
 * The calling app, as the provisioning route authenticated it. Users who authorized its OAuth
 * client are linked to it as well as those it provisioned.
 */
export type ProvisioningApp = { appId: string; oauthClientId: string };

/** Auth's side of provisioning: users, organizations, and their memberships. */
export type AuthAppProvisioningCommands = {
  provisionAppUser(input: { appId: string } & ProvisionUserInput): Promise<ProvisionUserResult>;
  provisionAppOrganization(
    input: ProvisioningApp & ProvisionOrganizationInput,
  ): Promise<AppProvisioningResult<ProvisionOrganizationResult>>;
  /** The organization the app provisioned for one of its own, and who it was made for. */
  findAppOrganization(input: {
    appId: string;
    externalOrganizationId: string;
  }): Promise<{ organizationId: string; createdByUserId: string } | null>;
  syncAppOrganizationMembers(
    input: ProvisioningApp & SyncOrganizationMembersInput,
  ): Promise<AppProvisioningResult<SyncOrganizationMembersResult>>;
};
