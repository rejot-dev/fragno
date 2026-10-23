import { BackofficeApiRequestError } from "@fragno-dev/backoffice-api/v0/client";
import { env } from "cloudflare:workers";

import { createProvisioningClient } from "../../workers/backoffice/client";
import type { ProvisionedOrganization } from "../../workers/directory/directory";
import { isOutcomeUnknown } from "./access.server";

/** An organization for Bookkeeping to create in Backoffice; a client names its firm. */
export type OrganizationRequest = {
  /**
   * Bookkeeping's identifier for it, chosen when the form was shown. Provisioning the same one
   * again returns what the first attempt made, so a retry after a failure never creates a second.
   */
  externalId: string;
  name: string;
  /** The Backoffice user who becomes its owner; they must have signed in. Others are invited. */
  ownerUserId: string;
} & ({ kind: "firm" } | { kind: "client"; firmId: string });

export type ProvisionResult =
  | { status: "provisioned"; organization: ProvisionedOrganization }
  /** Backoffice refused the request itself; asking again cannot change its answer. */
  | { status: "refused"; message: string }
  /** The outcome is unknown; submitting the same request again is safe. */
  | { status: "unavailable" };

/**
 * Creates the organization in Backoffice, which installs Bookkeeping there and makes the owner its
 * owner, then records it in the directory. Both steps are idempotent. Only a creation makes the
 * owner an owner: an organization that already existed may have removed them since, so their
 * membership is left for the next visit to confirm.
 */
export async function provisionOrganization(
  request: OrganizationRequest,
): Promise<ProvisionResult> {
  let provisioned;
  try {
    const provisioning = await createProvisioningClient(env);
    provisioned = await provisioning.call("organizations.provision", {
      // Kinds have their own identifiers, so a firm and a client never share one.
      externalOrganizationId: `${request.kind}:${request.externalId}`,
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
  const named = { id: provisioned.organizationId, slug: provisioned.slug, name: request.name };
  const organization: ProvisionedOrganization =
    request.kind === "firm"
      ? { ...named, kind: "firm" }
      : { ...named, kind: "client", firmId: request.firmId };
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
