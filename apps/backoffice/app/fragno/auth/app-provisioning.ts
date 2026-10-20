import type { BackofficeApiErrorCode } from "@fragno-dev/backoffice-api/errors";
import type { OrganizationMembershipRecord } from "@fragno-dev/backoffice-api/v0/organization";
import type {
  AcceptInvitationInput,
  ProvisionOrganizationInput,
  ProvisionOrganizationResult,
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

/** The calling app, as the provisioning route authenticated it. */
export type ProvisioningApp = { appId: string; oauthClientId: string };

/** Auth's side of provisioning: organizations, and the app's users joining them. */
export type AuthAppProvisioningCommands = {
  provisionAppOrganization(
    input: ProvisioningApp & ProvisionOrganizationInput,
  ): Promise<AppProvisioningResult<ProvisionOrganizationResult>>;
  /** The organization the app provisioned for one of its own, and who it was made for. */
  findAppOrganization(input: {
    appId: string;
    externalOrganizationId: string;
  }): Promise<{ organizationId: string; createdByUserId: string } | null>;
  findInvitationOrganization(input: { invitationId: string }): Promise<string | null>;
  acceptAppInvitation(
    input: Pick<ProvisioningApp, "oauthClientId"> & AcceptInvitationInput,
  ): Promise<AppProvisioningResult<OrganizationMembershipRecord>>;
};
