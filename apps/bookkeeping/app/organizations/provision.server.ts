import { BackofficeApiRequestError } from "@fragno-dev/backoffice-api/v0/client";
import { env } from "cloudflare:workers";

import { createProvisioningClient } from "../../workers/backoffice/client";
import type { ProvisionedOrganization } from "../../workers/directory/directory";
import { isOutcomeUnknown } from "./access.server";

/** What every organization Bookkeeping creates in Backoffice is asked for with. */
type OrganizationRequest = {
  /**
   * Bookkeeping's identifier for it, chosen when the form was shown. Provisioning the same one
   * again returns what the first attempt made, so a retry after a failure never creates a second.
   */
  externalId: string;
  name: string;
};

export type ProvisionResult =
  | { status: "provisioned"; organization: ProvisionedOrganization }
  /** Backoffice refused the request itself; asking again cannot change its answer. */
  | { status: "refused"; message: string }
  /** The outcome is unknown; submitting the same request again is safe. */
  | { status: "unavailable" };

/**
 * Creates the firm in Backoffice, which installs Bookkeeping there and makes the owner its owner,
 * then records it in the directory. Both steps are idempotent. Only a creation makes the owner an
 * owner: a firm that already existed may have removed them since, so their membership is left for
 * the next visit to confirm.
 */
export async function provisionFirm(
  request: OrganizationRequest & {
    /** The Backoffice user who becomes its owner; they must have signed in. Others are invited. */
    ownerUserId: string;
  },
): Promise<ProvisionResult> {
  let provisioned;
  try {
    const provisioning = await createProvisioningClient(env);
    provisioned = await provisioning.call("organizations.provision", {
      // Kinds have their own identifiers, so a firm and a client never share one.
      externalOrganizationId: `firm:${request.externalId}`,
      name: request.name,
      ownerUserId: request.ownerUserId,
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
  const organization: ProvisionedOrganization = {
    id: provisioned.organizationId,
    slug: provisioned.slug,
    name: request.name,
    kind: "firm",
  };
  await env.DIRECTORY.getByName("directory").recordProvisioned({
    organization,
    ownerUserId: provisioned.created ? request.ownerUserId : null,
  });
  return { status: "provisioned", organization };
}

export type FirmForInviteeResult =
  | {
      status: "provisioned";
      organization: ProvisionedOrganization;
      /** The owner invitation to deliver; null once the owner accepted. */
      ownerInvitation: { id: string; expiresAt: number } | null;
    }
  | { status: "refused"; message: string }
  | { status: "unavailable" };

/**
 * Creates a firm for an owner who need not have signed in yet: Backoffice creates it with no
 * members and a pending owner invitation from `invitedByUserId`, who does not become a member, and
 * installs Bookkeeping there. Provisioning it again returns the same pending invitation.
 */
export async function provisionFirmForInvitee(request: {
  externalId: string;
  name: string;
  ownerEmail: string;
  invitedByUserId: string;
}): Promise<FirmForInviteeResult> {
  let provisioned;
  try {
    const provisioning = await createProvisioningClient(env);
    provisioned = await provisioning.call("organizations.provisionForInvitee", {
      externalOrganizationId: `firm:${request.externalId}`,
      name: request.name,
      ownerEmail: request.ownerEmail,
      invitedByUserId: request.invitedByUserId,
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
  const organization: ProvisionedOrganization = {
    id: provisioned.organizationId,
    slug: provisioned.slug,
    name: request.name,
    kind: "firm",
  };
  await env.DIRECTORY.getByName("directory").recordProvisioned({ organization, ownerUserId: null });
  const { ownerInvitation } = provisioned;
  return {
    status: "provisioned",
    organization,
    ownerInvitation: ownerInvitation && {
      id: ownerInvitation.invitationId,
      expiresAt: Date.parse(ownerInvitation.expiresAt),
    },
  };
}

/**
 * Creates a client in Backoffice, managed by its firm, then records it in the directory. Every
 * member of the firm acts in it with their role in the firm, owners as admins, without becoming its
 * member, so it starts with no members: the firm invites its owner from its members page.
 * `createdByUserId`, an owner or admin of the firm, is recorded as its creator. Both steps are
 * idempotent.
 */
export async function provisionClient(
  request: OrganizationRequest & { firmId: string; createdByUserId: string },
): Promise<ProvisionResult> {
  let provisioned;
  try {
    const provisioning = await createProvisioningClient(env);
    provisioned = await provisioning.call("organizations.provisionManaged", {
      externalOrganizationId: `client:${request.externalId}`,
      name: request.name,
      managingOrganizationId: request.firmId,
      byUserId: request.createdByUserId,
      owner: { kind: "none" },
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
  const organization: ProvisionedOrganization = {
    id: provisioned.organizationId,
    slug: provisioned.slug,
    name: request.name,
    kind: "client",
    firmId: request.firmId,
  };
  await env.DIRECTORY.getByName("directory").recordProvisioned({ organization, ownerUserId: null });
  return { status: "provisioned", organization };
}
