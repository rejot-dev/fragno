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
  /** Whether the user authorized the app and is a member of the organization. */
  confirmAppOrganizationMember(input: {
    oauthClientId: string;
    organizationId: string;
    userId: string;
  }): Promise<AppProvisioningResult<null>>;
  findInvitationOrganization(input: { invitationId: string }): Promise<string | null>;
  acceptAppInvitation(
    input: Pick<ProvisioningApp, "oauthClientId"> & AcceptInvitationInput,
  ): Promise<AppProvisioningResult<OrganizationMembershipRecord>>;
};
