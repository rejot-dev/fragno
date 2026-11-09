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
import { documentRequestPrefix } from "../../workers/backoffice/review-requests";
import type { DocumentView } from "../../workers/books/documents/documents";
import { canManage } from "../../workers/directory/membership";
import { agentSteps, type AgentStep } from "../books/agent-steps";
import type { requireBooks } from "../books/books.server";
import {
  backofficeProblem,
  isOutcomeUnknown,
  type OrganizationContext,
} from "../organizations/access.server";

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
 * Bookkeeping's installation in the administration's project, which shares the document, and in
 * the agent project of the firm keeping its books, which holds the agent. Bookkeeping prompts the
 * agent as its installation, not as the person, so the agent's calls to Bookkeeping can answer
 * reviews and change nothing else, whatever a document tells it. `firmId` is the firm the request
 * was recorded with, read once, so the request never reaches a firm it was not recorded for.
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

/**
 * Asks the bookkeeping agent to propose the entry booking `document`. The upload asks `first`:
 * under one request ID, and only while the document has no review, so sending it again never asks
 * twice; asking `again` sends a new request. The request is recorded first, so one that never
 * reached the agent, e.g. because Backoffice could not set it up, shows on the document's page to
 * ask again. Returns why it was not sent instead.
 */
export async function askBookkeeper(
  context: BooksContext,
  document: Pick<DocumentView, "id" | "filename" | "storageKey">,
  ask: "first" | "again",
): Promise<{ ok: true } | { ok: false; error: string }> {
  const requestId = `${documentRequestPrefix(context.administration.id, document.id)}${ask === "first" ? "upload" : crypto.randomUUID()}`;
  // Read now, not when the page started, and recorded with the request: a change of firm after
  // this withdraws the request, and the books refuse it once they heard of a change.
  const management = await env.DIRECTORY.getByName("directory").findClient(context.organization.id);
  if (management === null) {
    return { ok: false, error: "These books belong to no client Bookkeeping knows." };
  }
  const recorded = await context.books.requestReview({
    documentId: document.id,
    request: {
      status: "requested",
      requestId,
      by: context.user.name,
      at: new Date().toISOString(),
    },
    first: ask === "first",
    generation: management.generation,
  });
  if (!recorded.ok) {
    return { ok: false, error: recorded.message };
  }
  const review = recorded.value;
  // Another request or an answer came first. Sending this request again is safe: Backoffice
  // queues a request ID once.
  if (review.status !== "requested" || review.requestId !== requestId) {
    return { ok: true };
  }
  try {
    const connected = await connectToAgent(context, management.firmId);
    if (!connected.ok) {
      return { ok: false, error: connected.error };
    }
    const { agent } = connected;
    const { organization, administration } = context;
    const awaited = await shareForRequest(env, {
      administration,
      projects: { administration: connected.administration, agent },
      document,
      requestId,
    });
    // Answered meanwhile, e.g. by a person: the agent has nothing to answer.
    if (!awaited) {
      return { ok: true };
    }
    // Each document is a subagent of its own: documents are read side by side, and no document
    // sees another's text.
    const prompt = {
      agentName: BOOKKEEPER_AGENT_NAME,
      requestId,
      subagent: true,
      content: `Propose the entry for document ${document.id} (${document.filename}) of administration ${administration.id}, ${organization.name}'s ${administration.name}. Its file is the blob ${await sharedDocumentKey(administration.id, document)}. This is request ${requestId}: give it as \`request\` when you answer with documents.propose or documents.decline.`,
    };
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
    if (!(await submit())) {
      // The firm's project has no agent, as when the package was removed while Bookkeeping was
      // uninstalled.
      await env.DIRECTORY.getByName("directory").reinstallAgentPackage(agent.scope.projectId);
      if (!(await submit())) {
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
 * Where the agent stands with a request: Backoffice's answer with the steps of the agent's work,
 * `lost` when the agent never received it, or `unknown` with why Backoffice could not say.
 */
export type BookkeeperProgress =
  | (PiPromptStatus & { steps: AgentStep[] })
  | { status: "lost" }
  | { status: "unknown"; message: string };

export async function readBookkeeperProgress(
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
 * Revokes the shares of a document the agent no longer needs: its review was answered, or it is
 * booked or dismissed, which its page shows next. Answering revokes them already; this catches
 * what that could not.
 */
export async function releaseDocumentIfDone(
  context: BooksContext,
  document: DocumentView,
): Promise<void> {
  const { review } = document;
  if (review?.status === "requested" && document.state.status === "to-book") {
    return;
  }
  try {
    await releaseDocument(env, context.administration, document.id);
  } catch (error) {
    console.warn("Bookkeeping could not revoke a document's shares.", error);
  }
}
