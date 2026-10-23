import { BackofficeApiRequestError } from "@fragno-dev/backoffice-api/v0/client";
import type { OrganizationRole } from "@fragno-dev/backoffice-api/v0/organization";
import { env } from "cloudflare:workers";

import type { SessionUser } from "../../workers/auth/auth";
import { createProvisioningClient } from "../../workers/backoffice/client";
import type { Invitation, Organization } from "../../workers/directory/directory";
import { isOutcomeUnknown } from "../organizations/access.server";

export type InvitationResult =
  | {
      status: "invited";
      email: string;
      /** Bookkeeping's page for accepting it, to share by hand when the email was not sent. */
      link: string;
      /**
       * Backoffice took the email for sending. It may still not arrive, and a local Backoffice only
       * prints it, so Bookkeeping always shows the link too.
       */
      emailed: boolean;
    }
  /**
   * Backoffice refused: the inviter's role does not allow it (`forbidden`), the address is already
   * a member or invited with other roles (`conflict`), or Bookkeeping is no longer installed there
   * (`not_found`).
   */
  | { status: "refused"; message: string }
  /** The outcome is unknown; inviting again returns the invitation if it was created. */
  | { status: "unavailable" };

export function invitationLink(invitationId: string): string {
  return new URL(`/invitations/${invitationId}`, env.BOOKKEEPING_BASE_URL).toString();
}

/**
 * Asks Backoffice to email the invitation in Bookkeeping's name, linking to Bookkeeping's page for
 * accepting it. The invitation exists either way, so a failure only means the inviter shares the
 * link themselves.
 */
async function emailInvitation(invitationId: string): Promise<boolean> {
  try {
    const provisioning = await createProvisioningClient(env);
    await provisioning.call("invitations.send", {
      invitationId,
      url: invitationLink(invitationId),
    });
    return true;
  } catch (error) {
    if (isOutcomeUnknown(error) || error instanceof BackofficeApiRequestError) {
      console.warn("The invitation email was not sent:", (error as Error).message);
      return false;
    }
    throw error;
  }
}

/**
 * Has Backoffice invite someone as `inviter`. Backoffice checks that they are a member and applies
 * their current role: owners and admins invite, only owners invite owners. Inviting the same
 * address with the same roles again returns the pending invitation, and Backoffice emails each
 * invitation once.
 */
export async function invite(input: {
  organization: Organization;
  inviter: SessionUser;
  email: string;
  roles: OrganizationRole[];
}): Promise<InvitationResult> {
  let created;
  try {
    const provisioning = await createProvisioningClient(env);
    created = await provisioning.call("invitations.create", {
      organizationId: input.organization.id,
      inviterUserId: input.inviter.backofficeUserId,
      email: input.email,
      roles: input.roles,
    });
  } catch (error) {
    if (isOutcomeUnknown(error)) {
      return { status: "unavailable" };
    }
    if (error instanceof BackofficeApiRequestError) {
      return { status: "refused", message: error.message };
    }
    throw error;
  }
  return await deliverInvitation({
    id: created.invitationId,
    organization: input.organization,
    email: created.email,
    roles: input.roles,
    invitedBy: input.inviter.name,
    expiresAt: Date.parse(created.expiresAt),
  });
}

/**
 * Keeps an invitation Backoffice created, for the page that accepts it, and has Backoffice email
 * it. Both are idempotent, so delivering it again changes nothing.
 */
export async function deliverInvitation(
  invitation: Invitation,
): Promise<Extract<InvitationResult, { status: "invited" }>> {
  const { organization, ...kept } = invitation;
  await env.DIRECTORY.getByName("directory").addInvitation({
    ...kept,
    organizationId: organization.id,
  });
  return {
    status: "invited",
    email: invitation.email,
    link: invitationLink(invitation.id),
    emailed: await emailInvitation(invitation.id),
  };
}
