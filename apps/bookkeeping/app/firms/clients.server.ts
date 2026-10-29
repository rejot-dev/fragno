import { BackofficeApiRequestError } from "@fragno-dev/backoffice-api/v0/client";
import type { ManagedOrganizationPage } from "@fragno-dev/backoffice-api/v0/provisioning";
import { env } from "cloudflare:workers";

import { createProvisioningClient } from "../../workers/backoffice/client";
import { followManager } from "../../workers/backoffice/management";
import { confirmManager, isOutcomeUnknown } from "../organizations/access.server";

/**
 * Records the clients Backoffice says the firm manages, withdrawing what the firm's agent was asked
 * about a client it no longer manages. A Backoffice administrator may end a client's management,
 * or move it to another firm, and a client the firm created may have no member of its own to open
 * it and tell Bookkeeping. When Backoffice cannot say, the clients Bookkeeping knows stand.
 */
export async function confirmClients(request: Request, firmId: string): Promise<void> {
  // Read before asking Backoffice, so a list arriving after a newer change changes nothing.
  const known = await env.DIRECTORY.getByName("directory").listClients(firmId);
  const clientIds: string[] = [];
  try {
    const provisioning = await createProvisioningClient(env);
    let cursor: string | null = null;
    do {
      // Each page needs the previous one's cursor.
      // oxlint-disable-next-line no-await-in-loop
      const page: ManagedOrganizationPage = await provisioning.call("organizations.listManaged", {
        managingOrganizationId: firmId,
        pageSize: 100,
        cursor,
      });
      clientIds.push(...page.organizations.map(({ organizationId }) => organizationId));
      cursor = page.hasNextPage ? page.nextCursor : null;
    } while (cursor !== null);
  } catch (error) {
    if (isOutcomeUnknown(error) || error instanceof BackofficeApiRequestError) {
      console.warn("Bookkeeping could not confirm the firm's clients.", error);
      return;
    }
    throw error;
  }
  const listed = new Set(clientIds);
  const knownIds = new Set(known.map(({ id }) => id));
  await Promise.all([
    // A client the firm no longer manages is recorded with none until Backoffice next confirms one
    // of its people, which names any firm managing it now.
    ...[...knownIds]
      .filter((id) => !listed.has(id))
      .map((clientId) =>
        followManager(env, { clientId, expectedFirmId: firmId, managingOrganizationId: null }),
      ),
    // A client the firm newly manages was recorded with another firm or none, which this list
    // cannot tell apart from a newer change, so Backoffice confirms it as the firm's member.
    ...clientIds.filter((id) => !knownIds.has(id)).map((id) => confirmManager(request, id)),
  ]);
}
