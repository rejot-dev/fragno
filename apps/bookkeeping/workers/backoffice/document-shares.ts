import {
  BackofficeApiRequestError,
  type BackofficeApiClient,
} from "@fragno-dev/backoffice-api/v0/client";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { Administration } from "../directory/directory";
import { connectAsInstallation } from "./client";

/**
 * A document's file reaches the bookkeeping agent of the firm keeping its books as a share of the
 * document's folder: from the administration's project to the firm's agent project, which mounts
 * it read-only under a name derived from the document. The client's workspace never holds the
 * firm's skills, and the firm reads only the documents it is asked about, while it is asked.
 */

type Document = { id: string; storageKey: string };

/** Bookkeeping's installation in one Backoffice project. */
export type InstalledProject = {
  scope: Extract<BackofficeContextScope, { kind: "project" }>;
  backoffice: BackofficeApiClient;
};

/**
 * The firm's agent mounts the documents of every administration of the firm's clients, and a
 * document's ID is unique only in its administration, so the name derives from both. Both IDs
 * together are longer than a mount name may be, so they are hashed.
 */
async function mountName(administrationId: string, document: Document): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${administrationId}:${document.id}`),
  );
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0"));
  return `document-${hex.join("").slice(0, 40)}`;
}

/** The folder holding the document's file, which is all its share opens. */
function documentFolder(document: Document): string {
  return document.storageKey.slice(0, document.storageKey.lastIndexOf("/") + 1);
}

/** Where the firm's agent reads the file of a document of `administrationId` once it is shared. */
export async function sharedDocumentPath(
  administrationId: string,
  document: Document,
): Promise<string> {
  const filename = document.storageKey.slice(document.storageKey.lastIndexOf("/") + 1);
  return `/shared/${await mountName(administrationId, document)}/${filename}`;
}

async function sharesOf(administration: InstalledProject, document: Document) {
  const { shared } = await administration.backoffice.call(
    administration.scope,
    "state.listShares",
    {},
  );
  return shared.filter((share) => share.path === documentFolder(document));
}

/**
 * Shares the document's folder with the firm's agent project, which mounts it at
 * `sharedDocumentPath`. Sharing again, e.g. when asking again, reuses the share that stands.
 */
export async function shareDocument(input: {
  administration: InstalledProject;
  agent: InstalledProject;
  document: Document;
}): Promise<void> {
  const { administration, agent, document } = input;
  const standing = (await sharesOf(administration, document)).find(
    (share) => share.with.kind === "project" && share.with.projectId === agent.scope.projectId,
  );
  const share =
    standing ??
    (await administration.backoffice.call(administration.scope, "state.share", {
      path: documentFolder(document),
      with: agent.scope,
    }));
  const name = await mountName(administration.scope.projectId, document);
  const accept = () =>
    agent.backoffice.call(agent.scope, "state.acceptShare", {
      from: administration.scope,
      shareId: share.shareId,
      name,
    });
  try {
    await accept();
  } catch (error) {
    if (!(error instanceof BackofficeApiRequestError && error.code === "conflict")) {
      throw error;
    }
    // An earlier share of the document, revoked since, still holds the name.
    const { accepted } = await agent.backoffice.call(agent.scope, "state.listShares", {});
    await Promise.all(
      accepted
        .filter((candidate) => candidate.name === name)
        .map((stale) =>
          agent.backoffice.call(agent.scope, "state.revokeShare", { shareId: stale.shareId }),
        ),
    );
    await accept();
  }
}

async function revokeShares(administration: InstalledProject, document: Document): Promise<void> {
  const shares = await sharesOf(administration, document);
  await Promise.all(
    shares.map((share) =>
      administration.backoffice.call(administration.scope, "state.revokeShare", {
        shareId: share.shareId,
      }),
    ),
  );
}

/**
 * Revokes the document's shares as Bookkeeping's installation in its administration's project, so
 * the firm's agent no longer reads its file.
 */
export async function releaseDocument(
  env: CloudflareEnv,
  administration: Administration,
  documentId: string,
): Promise<void> {
  const document = await env.BOOKS.getByName(administration.id).getDocument(documentId);
  const scope = {
    kind: "project" as const,
    owner: { kind: "org" as const, orgId: administration.clientId, jurisdiction: null },
    projectId: administration.id,
  };
  const backoffice = await connectAsInstallation(env, scope);
  if (document && backoffice) {
    await revokeShares({ scope, backoffice }, document);
  }
}
