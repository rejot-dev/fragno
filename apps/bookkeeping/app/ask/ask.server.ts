import { BackofficeApiRequestError } from "@fragno-dev/backoffice-api/v0/client";
import type { PiAgentHistoryPage } from "@fragno-dev/backoffice-api/v0/pi";
import {
  renderPiAgentPrompt,
  type PiAgentAttachment,
} from "@fragno-dev/backoffice-api/v0/pi-conversation/prompt-attachments";
import { backofficeScopePathSegment } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { env } from "cloudflare:workers";

import { AGENT_PACKAGES } from "../../workers/backoffice/agents";
import { backofficeOrigin, connectAsInstallation } from "../../workers/backoffice/client";
import type { InstalledProject } from "../../workers/backoffice/document-shares";
import type { requireBooks } from "../books/books.server";
import { backofficeProblem, connectAsUser } from "../organizations/access.server";

type BooksContext = Awaited<ReturnType<typeof requireBooks>>;

/** What the chat calls the agent. */
export const BOOKS_AGENT_LABEL = "Assistant";

/** The administration's Backoffice project, in its client's organization. */
function projectScope(administration: { clientId: string; id: string }) {
  return {
    kind: "project" as const,
    owner: { kind: "org" as const, orgId: administration.clientId, jurisdiction: null },
    projectId: administration.id,
  };
}

function administrationScope({ administration }: BooksContext) {
  return projectScope(administration);
}

const NOT_INSTALLED = "Bookkeeping is not installed for this administration's project.";

const AGENT_INSTALLING = "The assistant is being set up. Try again in a moment.";

const BOOKS_AGENT_NAME = AGENT_PACKAGES.books.agent.agentName;

/**
 * Backoffice's API as Bookkeeping's installation in the administration's project, which prompts its
 * agent.
 */
async function connectToAdministration(
  context: BooksContext,
): Promise<{ ok: true; project: InstalledProject } | { ok: false; error: string }> {
  const scope = administrationScope(context);
  const backoffice = await connectAsInstallation(env, scope);
  return backoffice
    ? { ok: true, project: { scope, backoffice } }
    : { ok: false, error: NOT_INSTALLED };
}

/**
 * Says whether the administration's agent started its conversation: the agent's socket opens only
 * once its first question provisioned it. Installs the agent's package again when the project has
 * no agent, as when the package was removed while Bookkeeping was uninstalled. Returns why not
 * instead.
 */
export async function setUpBooksAgent(
  context: BooksContext,
): Promise<{ ok: true; provisioned: boolean } | { ok: false; error: string }> {
  try {
    const connected = await connectToAdministration(context);
    if (!connected.ok) {
      return connected;
    }
    const { scope, backoffice } = connected.project;
    const readAgent = async () => {
      try {
        return await backoffice.call(scope, "pi.agent.get", { agentName: BOOKS_AGENT_NAME });
      } catch (error) {
        if (error instanceof BackofficeApiRequestError && error.code === "not_found") {
          return null;
        }
        throw error;
      }
    };
    let agent = await readAgent();
    if (agent === null) {
      await env.DIRECTORY.getByName("directory").reinstallAgentPackage(context.administration.id);
      agent = await readAgent();
    }
    return agent === null
      ? { ok: false, error: AGENT_INSTALLING }
      : { ok: true, provisioned: agent.provisioned };
  } catch (error) {
    return { ok: false, error: backofficeProblem(error) };
  }
}

/** What the person asks of the agent: a question, or to stop or resume it. */
export type BooksAgentRequest =
  | { intent: "ask"; requestId: string; content: string; documents: string[] }
  | { intent: "stop" }
  | { intent: "resume" };

/**
 * What the agent reads for a message: its text, then the documents it carried by their files' blobs
 * in the administration's project, which the agent reads, as Backoffice's chat writes attachments;
 * null when one is not among the books' documents.
 */
async function withDocuments(
  context: BooksContext,
  text: string,
  documentIds: readonly string[],
): Promise<string | null> {
  const documents = await Promise.all(documentIds.map((id) => context.books.getDocument(id)));
  const attachments: PiAgentAttachment[] = [];
  for (const document of documents) {
    if (document === null) {
      return null;
    }
    attachments.push({
      kind: "blob",
      key: document.storageKey,
      contentType: document.mediaType,
      sizeBytes: document.sizeBytes,
    });
  }
  return renderPiAgentPrompt(text, attachments);
}

/**
 * Does what the person asked of the agent, as Bookkeeping's installation; returns why Backoffice
 * did not, or null. A question joins the agent's running turn, and resumes an agent someone stopped,
 * as in Backoffice's own chat; asking again under the same request ID asks once.
 */
export async function runBooksAgentRequest(
  context: BooksContext,
  request: BooksAgentRequest,
): Promise<string | null> {
  try {
    const connected = await connectToAdministration(context);
    if (!connected.ok) {
      return connected.error;
    }
    const { scope, backoffice } = connected.project;
    const agentName = BOOKS_AGENT_NAME;
    switch (request.intent) {
      case "ask": {
        const content = await withDocuments(context, request.content, request.documents);
        if (content === null) {
          return "A file of this message is not among the books' documents. Attach it again.";
        }
        await backoffice.call(scope, "pi.prompt.submit", {
          agentName,
          requestId: request.requestId,
          content,
          whenBusy: "steer",
          whenPaused: "resume",
        });
        return null;
      }
      case "stop":
        await backoffice.call(scope, "pi.agent.stop", { agentName });
        return null;
      case "resume":
        await backoffice.call(scope, "pi.agent.resume", { agentName });
        return null;
    }
  } catch (error) {
    return backofficeProblem(error);
  }
  throw new Error("Unsupported request of the books agent.");
}

/**
 * Where the person's browser follows the agent's conversation: its socket, opened with a ticket
 * asked for as the person, so Backoffice checks they may read it. A ticket opens one connection,
 * within a minute, and only from Bookkeeping's pages; null when Backoffice refused the person.
 */
export async function booksAgentSocketUrl(
  request: Request,
  context: BooksContext,
): Promise<string | null> {
  const scope = administrationScope(context);
  const backoffice = await connectAsUser(request, scope);
  if (!backoffice) {
    return null;
  }
  const agentName = BOOKS_AGENT_NAME;
  const { ticket } = await backoffice.call(scope, "pi.agent.watchTicket", { agentName });
  const query = new URLSearchParams({ agentName, ticket });
  return `${backofficeOrigin(env)}/api/v0/scopes/${backofficeScopePathSegment(scope)}/pi.agent.watch?${query}`;
}

/**
 * A page of the conversation from before its newest compaction, read as the person, as the socket
 * is; null when Backoffice refused the person.
 */
export async function booksAgentHistory(
  request: Request,
  context: BooksContext,
  page: { before: number; cursor: string | null },
): Promise<PiAgentHistoryPage | null> {
  const scope = administrationScope(context);
  const backoffice = await connectAsUser(request, scope);
  if (!backoffice) {
    return null;
  }
  return await backoffice.call(scope, "pi.agent.history", {
    agentName: BOOKS_AGENT_NAME,
    ...page,
  });
}

/**
 * Brings the firm's answer to a question the administration's agent asked it into the agent's
 * conversation, as Bookkeeping's installation, for the agent to pass on: delivering it again after
 * a failure delivers it once, so the answer must be the one the Directory kept. Returns why
 * Backoffice did not, or null.
 */
export async function deliverFirmAnswer(answered: {
  administration: { clientId: string; id: string };
  questionId: string;
  question: string;
  answer: string;
  answeredBy: string;
  firmName: string;
}): Promise<string | null> {
  const scope = projectScope(answered.administration);
  try {
    const backoffice = await connectAsInstallation(env, scope);
    if (!backoffice) {
      return NOT_INSTALLED;
    }
    await backoffice.call(scope, "pi.prompt.submit", {
      agentName: BOOKS_AGENT_NAME,
      requestId: `firm-answer:${answered.questionId}`,
      content: `${answered.answeredBy}, of ${answered.firmName}, answers the question you asked the accountants, "${answered.question}":\n\n${answered.answer}`,
      whenBusy: "followUp",
    });
    return null;
  } catch (error) {
    return backofficeProblem(error);
  }
}
