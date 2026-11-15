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

const BOOKKEEPER_AGENT_NAME = AGENT_PACKAGES.bookkeeper.agent.agentName;

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
 * agent project of the firm keeping its books, which holds the agent. Bookkeeping prompts the agent
 * as its installation, not as the person, so the agent's calls to Bookkeeping can answer requests
 * for proposals and change nothing else, whatever a document or a bank transaction tells it.
 * `firmId` is the firm the request was recorded with, read once, so the request never reaches a
 * firm it was not recorded for.
 */
async function connectToAgent(
  context: BooksContext,
  firmId: string | null,
): Promise<
  | { ok: true; firmId: string; administration: InstalledProject; agent: InstalledProject }
  | { ok: false; error: string }
> {
  const { organization, administration } = context;
  const directory = env.DIRECTORY.getByName("directory");
  if (firmId === null) {
    return {
      ok: false,
      error: "No firm keeps these books, so there is no bookkeeping agent to ask.",
    };
  }
  const projectId = await directory.findFirmAgent(firmId);
  if (projectId === null) {
    return {
      ok: false,
      error:
        "The firm keeping these books has not set up its bookkeeping agent yet: one of its owners or admins sets it up by opening the firm in Bookkeeping.",
    };
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
    firmId,
    administration: { scope: administrationScope, backoffice: clientBackoffice },
    agent: { scope: agentScope, backoffice: firmBackoffice },
  };
}

/** What the bookkeeping agent is asked to propose how to book. */
export type ProposalSubject =
  | { kind: "document"; document: Pick<DocumentView, "id" | "filename" | "storageKey"> }
  | { kind: "transaction"; transaction: { id: string; description: string } };

function subjectId(subject: ProposalSubject): string {
  return subject.kind === "document" ? subject.document.id : subject.transaction.id;
}

/** Records the request, as the subject's books do. Returns the proposal in effect. */
function recordRequest(
  context: BooksContext,
  subject: ProposalSubject,
  request: ProposalRequest,
  first: boolean,
) {
  return subject.kind === "document"
    ? context.books.requestDocumentProposal({ documentId: subject.document.id, request, first })
    : context.books.requestTransactionProposal({
        transactionId: subject.transaction.id,
        request,
        first,
      });
}

/** What the agent is told about the subject: what it is, where it reads it, and how to answer. */
async function promptContent(
  context: BooksContext,
  subject: ProposalSubject,
  requestId: string,
): Promise<string> {
  const { organization, administration } = context;
  const books = `of administration ${administration.id}, ${organization.name}'s ${administration.name}`;
  if (subject.kind === "document") {
    const { document } = subject;
    return `Propose the entry for document ${document.id} (${document.filename}) ${books}. Its file is the blob ${await sharedDocumentKey(administration.id, document)}. This is request ${requestId}: give it as \`request\` when you answer with documents.propose or documents.decline.`;
  }
  const { transaction } = subject;
  return `Propose how to book bank transaction ${transaction.id} (${transaction.description}) ${books}. Read it with bank.transactions.get. This is request ${requestId}: give it as \`request\` when you answer with bank.transactions.propose or bank.transactions.decline.`;
}

/**
 * Asks the bookkeeping agent to propose how to book each subject, as a subagent of its own: an
 * upload or an import asks `first`, under one request ID per subject, and only while the subject
 * has no proposal, so sending it again never asks twice; asking `again` sends a new request. Every
 * request is recorded first, so one that never reached the agent, e.g. because Backoffice could
 * not set it up, shows on the subject's page to ask again. A document's file is shared with the
 * agent while its request awaits an answer. Returns why the requests were not all sent instead.
 */
export async function askBookkeeper(
  context: BooksContext,
  subjects: ProposalSubject[],
  ask: "first" | "again",
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Read now, not when the page started, and recorded with the requests: a change of firm after
  // this withdraws them, and the books refuse them once they heard of a change.
  const management = await env.DIRECTORY.getByName("directory").findClient(context.organization.id);
  if (management === null) {
    return { ok: false, error: "These books belong to no client Bookkeeping knows." };
  }
  const asked = [];
  for (const subject of subjects) {
    // A subject is first asked about as it is uploaded or imported.
    const first = subject.kind === "document" ? "upload" : "import";
    const prefix = requestPrefix(context.administration.id, {
      kind: subject.kind,
      id: subjectId(subject),
    });
    const requestId = `${prefix}${ask === "first" ? first : crypto.randomUUID()}`;
    const recorded = await recordRequest(
      context,
      subject,
      {
        status: "requested",
        requestId,
        generation: management.generation,
        by: context.user.name,
        at: new Date().toISOString(),
      },
      ask === "first",
    );
    if (!recorded.ok) {
      return { ok: false, error: recorded.message };
    }
    const proposal = recorded.value;
    // Another request or an answer came first. Sending this request again is safe: Backoffice
    // queues a request ID once.
    if (proposal.status === "requested" && proposal.requestId === requestId) {
      asked.push({ subject, requestId });
    }
  }
  if (asked.length === 0) {
    return { ok: true };
  }
  try {
    const connected = await connectToAgent(context, management.firmId);
    if (!connected.ok) {
      return { ok: false, error: connected.error };
    }
    for (const { subject, requestId } of asked) {
      const awaited =
        subject.kind === "document"
          ? await shareForRequest(env, {
              administration: context.administration,
              projects: { administration: connected.administration, agent: connected.agent },
              document: subject.document,
              requestId,
            })
          : true;
      // Answered meanwhile, e.g. by a person: the agent has nothing to answer.
      if (!awaited) {
        continue;
      }
      const prompted = await promptAgent(connected.agent, {
        agentName: BOOKKEEPER_AGENT_NAME,
        requestId,
        // Each subject is a subagent of its own: subjects are read side by side, and none sees
        // another's text.
        subagent: true,
        content: await promptContent(context, subject, requestId),
      });
      if (!prompted) {
        return {
          ok: false,
          error: "The firm's bookkeeping agent is being set up. Ask again in a moment.",
        };
      }
    }
  } catch (error) {
    return { ok: false, error: `Backoffice did not ask the agent: ${backofficeProblem(error)}` };
  }
  return { ok: true };
}

/**
 * Submits a prompt to the firm's bookkeeping agent. Returns false when its project has no agent,
 * as when the package was removed while Bookkeeping was uninstalled, after reinstalling it.
 */
async function promptAgent(
  agent: InstalledProject,
  prompt: { agentName: string; requestId: string; subagent: boolean; content: string },
): Promise<boolean> {
  const submit = async () => {
    try {
      await agent.backoffice.call(agent.scope, "pi.prompt.submit", prompt);
      return true;
    } catch (error) {
      if (error instanceof BackofficeApiRequestError && error.code === "not_found") {
        return false;
      }
      throw error;
    }
  };
  if (await submit()) {
    return true;
  }
  await env.DIRECTORY.getByName("directory").reinstallAgentPackage(agent.scope.projectId);
  return await submit();
}

/**
 * Where the agent stands with a request: Backoffice's answer with the steps of the agent's work,
 * `lost` when the agent never received it, or `unknown` with why Backoffice could not say.
 */
export type BookkeeperProgress =
  | (PiPromptStatus & { steps: AgentStep[] })
  | { status: "lost" }
  | { status: "unknown"; message: string };

async function readBookkeeperProgress(
  context: BooksContext,
  requestId: string,
): Promise<BookkeeperProgress> {
  try {
    const client = await env.DIRECTORY.getByName("directory").findClient(context.organization.id);
    const connected = await connectToAgent(context, client?.firmId ?? null);
    if (!connected.ok) {
      return { status: "unknown", message: connected.error };
    }
    const { agent } = connected;
    const progress = await agent.backoffice.call(agent.scope, "pi.prompt.get", {
      agentName: BOOKKEEPER_AGENT_NAME,
      requestId,
    });
    // Read only for a request the agent received: the agent may not even exist otherwise.
    if (progress === null) {
      return { status: "lost" };
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
    return { status: "unknown", message: backofficeProblem(error) };
  }
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
  const progress = await readBookkeeperProgress(context, proposal.requestId);
  if (["queued", "running", "unknown"].includes(progress.status)) {
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
