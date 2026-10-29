import { releaseDocument } from "./document-shares";

const WITHDRAWN = "The firm asked no longer keeps these books.";

/**
 * Records the firm Backoffice says manages the client, by its `managingOrganizationId`, when that
 * changed: Backoffice's administrator may end a client's management, or move it to another firm.
 * `expectedFirmId` is the client's firm as Bookkeeping recorded it before asking Backoffice, so an
 * answer that arrives after a newer one changes nothing. The new firm is recorded first, so a
 * request asked from then on goes to it, then the requests the former firm's agent was asked are
 * withdrawn, so none of its answers counts, then the files that may still be shared are revoked.
 * A failure before the requests are withdrawn is retried at the next confirmation; what could not
 * be revoked, each document's page revokes. Returns the client's firm now, or null for none or an
 * organization that is no client.
 */
export async function followManager(
  env: CloudflareEnv,
  input: { clientId: string; expectedFirmId: string | null; managingOrganizationId: string | null },
): Promise<string | null> {
  const client = await env.DIRECTORY.getByName("directory").followManager(input);
  if (client === null) {
    return null;
  }
  if (client.withdrawalPending) {
    await withdrawFormerRequests(env, { clientId: input.clientId, firmId: client.firmId });
  }
  return client.firmId;
}

/** Withdraws the requests asked before the client's firm became `firmId`, and revokes their shares. */
async function withdrawFormerRequests(
  env: CloudflareEnv,
  input: { clientId: string; firmId: string | null },
): Promise<void> {
  const directory = env.DIRECTORY.getByName("directory");
  const administrations = await directory.listAdministrations(input.clientId);
  const withdrawn = await Promise.all(
    administrations.map(async (administration) => {
      const outcome = await env.BOOKS.getByName(administration.id).withdrawRequests({
        reason: WITHDRAWN,
      });
      if (!outcome.ok) {
        throw new Error(`The requests of ${administration.id} were not withdrawn.`);
      }
      return outcome.value.map((documentId) => ({ administration, documentId }));
    }),
  );
  await directory.endWithdrawal(input);
  await Promise.all(
    withdrawn.flat().map(({ administration, documentId }) =>
      releaseDocument(env, administration, documentId).catch((error: unknown) => {
        // Its page revokes them when it shows the document.
        console.warn("Bookkeeping could not revoke a withdrawn document's shares.", error);
      }),
    ),
  );
}
