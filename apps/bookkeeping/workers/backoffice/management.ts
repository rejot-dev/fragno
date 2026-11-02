import { releaseDocument } from "./document-shares";

const WITHDRAWN = "The firm asked no longer keeps these books.";

/**
 * Records the firm Backoffice says manages the client, by its `managingOrganizationId`, when that
 * changed: Backoffice's administrator may end a client's management, or move it to another firm.
 * `expectedFirmId` is the client's firm as Bookkeeping recorded it before asking Backoffice, so an
 * answer that arrives after a newer one changes nothing. The change starts a new generation of the
 * client's management, so a request asked from then on goes to the new firm, then the requests of
 * earlier generations are withdrawn, so none of their answers counts, then the files that may still
 * be shared are revoked. A withdrawal that fails is the Directory's to retry; what could not be
 * revoked, each document's page revokes. Returns the client's firm now, or null for none or an
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
    await withdrawFormerRequests(env, {
      clientId: input.clientId,
      generation: client.generation,
    }).catch((error: unknown) => {
      // The Directory retries it, so the change stands for whoever made it.
      console.warn("Bookkeeping could not withdraw a former firm's requests yet.", error);
    });
  }
  return client.firmId;
}

/**
 * Withdraws the requests asked before the client's management reached `generation`, and revokes
 * the shares of every document whose file may still be shared. Requests asked of the firm managing
 * the client since stand, and their files are shared again.
 */
export async function withdrawFormerRequests(
  env: CloudflareEnv,
  input: { clientId: string; generation: number },
): Promise<void> {
  const directory = env.DIRECTORY.getByName("directory");
  const administrations = await directory.listAdministrations(input.clientId);
  const withdrawn = await Promise.all(
    administrations.map(async (administration) => {
      const outcome = await env.BOOKS.getByName(administration.id).withdrawRequests({
        reason: WITHDRAWN,
        generation: input.generation,
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
