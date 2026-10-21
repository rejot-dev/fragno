import type { BackofficeApiErrorCode } from "@fragno-dev/backoffice-api/errors";
import type {
  OrganizationInvitationRecord,
  OrganizationMembershipRecord,
} from "@fragno-dev/backoffice-api/v0/organization";
import type {
  AcceptInvitationInput,
  CreateInvitationInput,
  ProvisionOrganizationInput,
  ProvisionOrganizationResult,
} from "@fragno-dev/backoffice-api/v0/provisioning";

/** Failures cross Durable Object RPC as values, coded as the provisioning API reports them. */
export type AppProvisioningResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        code: Extract<
          BackofficeApiErrorCode,
          "invalid_request" | "not_found" | "forbidden" | "conflict"
        >;
        message: string;
      };
    };

/** The calling app, as the provisioning route authenticated it. */
export type ProvisioningApp = { appId: string; oauthClientId: string };

/** An invitation as an app's invitation email describes it. */
export type AppInvitation = {
  organizationId: string;
  organizationName: string;
  email: string;
  inviterName: string;
  /** Not yet accepted, declined, canceled, or expired. */
  pending: boolean;
  expiresAt: string;
};

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
  createAppInvitation(
    input: Pick<ProvisioningApp, "oauthClientId"> & CreateInvitationInput,
  ): Promise<AppProvisioningResult<OrganizationInvitationRecord>>;
  findInvitation(input: { invitationId: string }): Promise<AppInvitation | null>;
  acceptAppInvitation(
    input: Pick<ProvisioningApp, "oauthClientId"> & AcceptInvitationInput,
  ): Promise<AppProvisioningResult<OrganizationMembershipRecord>>;
};
