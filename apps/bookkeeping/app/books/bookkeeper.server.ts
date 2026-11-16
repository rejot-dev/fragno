import { BackofficeApiRequestError } from "@fragno-dev/backoffice-api/v0/client";
import type { PiPromptStatus } from "@fragno-dev/backoffice-api/v0/pi";
import { env } from "cloudflare:workers";

import { AGENT_PACKAGES } from "../../workers/backoffice/agents";
import { connectAsInstallation, createProvisioningClient } from "../../workers/backoffice/client";
import {
  releaseDocument,
  shareForRequest,
  sharedDocumentKey,
  type InstalledProject,
} from "../../workers/backoffice/document-shares";
import { requestPrefix } from "../../workers/backoffice/proposal-requests";
import type { DocumentView } from "../../workers/books/documents/documents";
import type { AgentProposal, ProposalRequest } from "../../workers/books/proposals/schema";
import { canManage } from "../../workers/directory/membership";
import {
  backofficeProblem,
  isOutcomeUnknown,
  type OrganizationContext,
} from "../organizations/access.server";
import { agentSteps, type AgentStep } from "./agent-steps";
import type { requireBooks } from "./books.server";

type BooksContext = Awaited<ReturnType<typeof requireBooks>>;

const NOT_INSTALLED = "Bookkeeping is not installed for this administration's project.";

const NO_FIRM = "No firm keeps these books, so there is no bookkeeping agent to ask.";

const NO_FIRM_AGENT =
  "The firm keeping these books has not set up its bookkeeping agent yet: one of its owners or admins sets it up by opening the firm in Bookkeeping.";

const BOOKKEEPER_AGENT_NAME = AGENT_PACKAGES.bookkeeper.agentName;

/** Where Bookkeeping provisions each firm's agent project, so provisioning again finds it. */
const FIRM_AGENT_PROJECT = { externalProjectId: "bookkeeper", name: "Bookkeeping agent" };

/**
 * Sets up the project holding the firm's bookkeeping agent, once, when an owner or admin opens the
 * firm: Backoffice creates a project as one of the firm's members who authorized Bookkeeping, and
 * the client's members who upload documents need not be the firm's. Recording it installs the
 * agent's package there. When Backoffice cannot, the next visit sets it up.
 */
export async function setUpFirmAgent(context: OrganizationContext): Promise<void> {
  const { organization, user, roles } = context;
  const directory = env.DIRECTORY.getByName("directory");
  if (!canManage(roles) || (await directory.findFirmAgent(organization.id)) !== null) {
    return;
  }
  try {
    const provisioning = await createProvisioningClient(env);
    const project = await provisioning.call("projects.provision", {
      organizationId: organization.id,
      ...FIRM_AGENT_PROJECT,
      createdByUserId: user.backofficeUserId,
    });
    await directory.recordFirmAgent({ firmId: organization.id, projectId: project.projectId });
  } catch (error) {
    if (isOutcomeUnknown(error) || error instanceof BackofficeApiRequestError) {
      console.warn("Bookkeeping could not set up the firm's bookkeeping agent.", error);
      return;
    }
    throw error;
  }
}

/**
 * Bookkeeping's installation in the administration's project, which shares documents, and in the
 * agent project of the firm keeping its books, which holds the agent. `firmId` is the firm the
 * request was recorded with, read once, so the request never reaches a firm it was not recorded
 * for.
 */
async function connectToAgent(
  context: BooksContext,
  firmId: string,
): Promise<
  | { ok: true; administration: InstalledProject; agent: InstalledProject }
  | { ok: false; error: string }
> {
  const { organization, administration } = context;
  const projectId = await env.DIRECTORY.getByName("directory").findFirmAgent(firmId);
  if (projectId === null) {
    return { ok: false, error: NO_FIRM_AGENT };
  }
  const administrationScope = {
    kind: "project" as const,
    owner: { kind: "org" as const, orgId: organization.id, jurisdiction: null },
    projectId: administration.id,
  };
  const agentScope = {
    kind: "project" as const,
    owner: { kind: "org" as const, orgId: firmId, jurisdiction: null },
    projectId,
  };
  const [clientBackoffice, firmBackoffice] = await Promise.all([
    connectAsInstallation(env, administrationScope),
    connectAsInstallation(env, agentScope),
  ]);
  if (!clientBackoffice) {
    return { ok: false, error: NOT_INSTALLED };
  }
  if (!firmBackoffice) {
    return { ok: false, error: "Bookkeeping is not installed for the firm's bookkeeping agent." };
  }
  return {
    ok: true,
    administration: { scope: administrationScope, backoffice: clientBackoffice },
    agent: { scope: agentScope, backoffice: firmBackoffice },
  };
}

/** What the bookkeeping agent is asked to propose how to book. */
export type ProposalSubject =
  | { kind: "document"; document: Pick<DocumentView, "id" | "filename" | "storageKey"> }
  | { kind: "transaction"; transaction: { id: string; description: string } };

type DocumentSubject = Extract<ProposalSubject, { kind: "document" }>;
type TransactionSubject = Extract<ProposalSubject, { kind: "transaction" }>;

/** Whom a request is asked of and for: the firm, under the generation read before, and by whom. */
type Asked = { generation: number; firmId: string; by: string; at: string };

/**
 * The ID of the request asking about `subject`: an upload or an import asks `first`, under one ID
 * per subject, so sending it again never asks twice; asking `again` sends a new one.
 */
function requestIdOf(
  context: BooksContext,
  subject: { kind: ProposalSubject["kind"]; id: string },
  ask: "first" | "again",
): string {
  const first = subject.kind === "document" ? "upload" : "import";
  return `${requestPrefix(context.administration.id, subject)}${ask === "first" ? first : crypto.randomUUID()}`;
}

/** What the agent is told about the subject: what it is, where it reads it, and how to answer. */
async function promptContent(
  context: BooksContext,
  subject: ProposalSubject,
  requestId: string,
): Promise<string> {
  const { organization, administration } = context;
  // The agent once gave the books' name where their ID belongs, so the prompt says which is which.
  const books = `in the books of ${organization.name}'s ${administration.name}, whose administration ID is ${administration.id}: give \`administration: "${administration.id}"\` in every action's input`;
  if (subject.kind === "document") {
    const { document } = subject;
    return `Propose the entry for document ${document.id} (${document.filename}) ${books}. Its file is the blob ${await sharedDocumentKey(administration.id, document)}. This is request ${requestId}: give it as \`request\` when you answer with documents.propose or documents.decline.`;
  }
  const { transaction } = subject;
  return `Propose how to book bank transaction ${transaction.id} (${transaction.description}) ${books}. Read it with bank.transactions.get. This is request ${requestId}: give it as \`request\` when you answer with bank.transactions.propose or bank.transactions.decline.`;
}

/**
 * Asks the bookkeeping agent of the firm keeping the books to propose how to book each subject:
 * the books record each request, under one ID per subject, only while the subject has no
 * proposal, unless asked `again`. Once a request commits, the books tell the firm, whose agent
 * starts a subagent for it; a document's request is told once its file is shared with the firm,
 * and only while the request awaits an answer. A request that never reached the agent, e.g.
 * because its file could not be shared, shows on its subject's page to ask again. Returns why the
 * requests were not all asked instead.
 */
export async function askBookkeeper(
  context: BooksContext,
  subjects: ProposalSubject[],
  ask: "first" | "again",
): Promise<{ ok: true } | { ok: false; error: string }> {
  const directory = env.DIRECTORY.getByName("directory");
  // Read now, not when the page started, and recorded with the requests: a change of firm after
  // this withdraws them, and the books refuse them once they heard of a change.
  const management = await directory.findClient(context.organization.id);
  if (management === null) {
    return { ok: false, error: "These books belong to no client Bookkeeping knows." };
  }
  if (management.firmId === null) {
    return { ok: false, error: NO_FIRM };
  }
  if ((await directory.findFirmAgent(management.firmId)) === null) {
    return { ok: false, error: NO_FIRM_AGENT };
  }
  const asked: Asked = {
    generation: management.generation,
    firmId: management.firmId,
    by: context.user.name,
    at: new Date().toISOString(),
  };
  const transactions = subjects.filter(
    (subject): subject is TransactionSubject => subject.kind === "transaction",
  );
  const documents = subjects.filter(
    (subject): subject is DocumentSubject => subject.kind === "document",
  );
  if (transactions.length > 0) {
    const asking = await askAboutTransactions(context, transactions, asked, ask);
    if (!asking.ok) {
      return asking;
    }
  }
  const asking = await Promise.all(
    documents.map((subject) => askAboutDocument(context, subject, asked, ask)),
  );
  return asking.find((outcome) => !outcome.ok) ?? { ok: true };
}

/** Records the requests about bank transactions in one call, which tells the firm of each. */
async function askAboutTransactions(
  context: BooksContext,
  subjects: TransactionSubject[],
  asked: Asked,
  ask: "first" | "again",
): Promise<{ ok: true } | { ok: false; error: string }> {
  const requests = await Promise.all(
    subjects.map(async (subject) => {
      const { id } = subject.transaction;
      const requestId = requestIdOf(context, { kind: "transaction", id }, ask);
      return {
        transactionId: id,
        requestId,
        prompt: await promptContent(context, subject, requestId),
      };
    }),
  );
  const recorded = await context.books.requestTransactionProposals({
    requests,
    asked,
    first: ask === "first",
  });
  return recorded.ok ? { ok: true } : { ok: false, error: recorded.message };
}

/**
 * Records the request about a document, shares its file with the firm's agent while the request
 * awaits an answer, then has the books tell the firm of it.
 */
async function askAboutDocument(
  context: BooksContext,
  subject: DocumentSubject,
  asked: Asked,
  ask: "first" | "again",
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { document } = subject;
  const requestId = requestIdOf(context, { kind: "document", id: document.id }, ask);
  const recorded = await context.books.requestDocumentProposal({
    documentId: document.id,
    requestId,
    asked,
    first: ask === "first",
  });
  if (!recorded.ok) {
    return { ok: false, error: recorded.message };
  }
  const proposal = recorded.value;
  // Another request or an answer came first, or the firm was told of this one already.
  if (proposal.status !== "requested" || proposal.requestId !== requestId || proposal.announced) {
    return { ok: true };
  }
  try {
    const connected = await connectToAgent(context, asked.firmId);
    if (!connected.ok) {
      return { ok: false, error: connected.error };
    }
    const awaited = await shareForRequest(env, {
      administration: context.administration,
      projects: { administration: connected.administration, agent: connected.agent },
      document,
      requestId,
    });
    // Answered meanwhile, e.g. by a person: the agent has nothing to answer.
    if (!awaited) {
      return { ok: true };
    }
  } catch (error) {
    return {
      ok: false,
      error: `Backoffice did not share the document with the agent: ${backofficeProblem(error)}`,
    };
  }
  const announced = await context.books.announceDocumentRequest({
    documentId: document.id,
    requestId,
    prompt: await promptContent(context, subject, requestId),
  });
  return announced.ok ? { ok: true } : { ok: false, error: announced.message };
}

/**
 * Where the agent stands with a request: Backoffice's answer with the steps of the agent's work
 * once the agent started on it. Before, `unsent` when the books never told the firm of it, such as
 * a document whose file could not be shared; `sending` while they keep trying to; `undelivered`
 * once they gave up; and `waiting` once Backoffice took it, for the agent to start on it. `unknown`
 * says why Backoffice could not say.
 */
export type BookkeeperProgress =
  | (PiPromptStatus & { steps: AgentStep[] })
  | { status: "unsent" }
  | { status: "sending" }
  | { status: "undelivered"; reason: string }
  | { status: "waiting" }
  | { status: "unknown"; message: string };

async function readBookkeeperProgress(
  context: BooksContext,
  request: ProposalRequest,
): Promise<BookkeeperProgress> {
  if (!request.announced) {
    return { status: "unsent" };
  }
  const { requestId } = request;
  try {
    const connected = await connectToAgent(context, request.firmId);
    if (!connected.ok) {
      return (
        (await undelivered(context, requestId)) ?? { status: "unknown", message: connected.error }
      );
    }
    const { agent } = connected;
    const progress = await agent.backoffice.call(agent.scope, "pi.prompt.get", {
      agentName: BOOKKEEPER_AGENT_NAME,
      requestId,
    });
    // Read only for a request the agent started on: the agent may not even exist otherwise.
    if (progress === null) {
      return (await undelivered(context, requestId)) ?? { status: "waiting" };
    }
    // The request runs in a subagent of its own, which its request ID names.
    const activity = await agent.backoffice.call(agent.scope, "pi.agent.activity", {
      agentName: BOOKKEEPER_AGENT_NAME,
      subagent: requestId,
    });
    const steps = agentSteps(
      activity.tools.map((tool) => ({
        running: tool.status === "running",
        calls: tool.calls?.items ?? null,
      })),
    );
    return { ...progress, steps };
  } catch (error) {
    const message = backofficeProblem(error);
    return (await undelivered(context, requestId)) ?? { status: "unknown", message };
  }
}

/**
 * Where the books stand telling the firm of the request, unless they told it: the books know that
 * without Backoffice, so it shows even while Backoffice cannot be reached.
 */
async function undelivered(
  context: BooksContext,
  requestId: string,
): Promise<BookkeeperProgress | null> {
  const delivery = await context.books.requestDelivery(requestId);
  if (delivery.status === "pending") {
    return { status: "sending" };
  }
  if (delivery.status === "failed") {
    return { status: "undelivered", reason: delivery.error };
  }
  return null;
}

/**
 * What `read` gives, with how far the bookkeeping agent got with the request it awaits an answer
 * to, if it is to book and awaits one; null progress otherwise.
 */
export async function withBookkeeperProgress<
  TSubject extends { proposal: AgentProposal<unknown> | null; state: { status: string } },
>(
  context: BooksContext,
  read: () => Promise<TSubject>,
): Promise<{ subject: TSubject; progress: BookkeeperProgress | null }> {
  const subject = await read();
  const { proposal } = subject;
  if (subject.state.status !== "to-book" || proposal?.status !== "requested") {
    return { subject, progress: null };
  }
  const progress = await readBookkeeperProgress(context, proposal);
  if (progress.status !== "completed" && progress.status !== "failed") {
    return { subject, progress };
  }
  // The agent answers before its turn ends, so a turn that ended may have answered since.
  const reread = await read();
  if (reread.proposal?.status === "requested" && reread.proposal.requestId === proposal.requestId) {
    return { subject: reread, progress };
  }
  return await withBookkeeperProgress(context, read);
}

/**
 * Revokes the shares of a document the agent no longer needs: its request was answered, or it is
 * booked or dismissed, which its page shows next. Answering revokes them already; this catches
 * what that could not.
 */
export async function releaseDocumentIfDone(
  context: BooksContext,
  document: DocumentView,
): Promise<void> {
  const { proposal } = document;
  if (proposal?.status === "requested" && document.state.status === "to-book") {
    return;
  }
  try {
    await releaseDocument(env, context.administration, document.id);
  } catch (error) {
    console.warn("Bookkeeping could not revoke a document's shares.", error);
  }
}
