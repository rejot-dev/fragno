import { BackofficeApiRequestError } from "@fragno-dev/backoffice-api/v0/client";
import type { PiAgentDefinitionCreate, PiPromptStatus } from "@fragno-dev/backoffice-api/v0/pi";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { DocumentView } from "../../workers/books/documents/documents";
import type { requireBooks } from "../books/books.server";
import { connectAsInstallation, isOutcomeUnknown } from "../organizations/access.server";

type BooksContext = Awaited<ReturnType<typeof requireBooks>>;

/**
 * The Backoffice agent, in each administration's project, that reads its documents and proposes
 * the entries booking them. Bookkeeping defines it there when it has none; a definition members
 * changed in Backoffice is theirs to keep.
 */
const BOOKKEEPER: PiAgentDefinitionCreate = {
  agentName: "bookkeeper",
  description:
    "Reads the invoices and receipts uploaded to Bookkeeping and proposes the entries that book them.",
  instructions: `You propose how to book the documents uploaded to this administration's books in Bookkeeping. People review your proposals and book them; you never post entries or change the books.

Run Bookkeeping's actions with \`integrations.execute({ connectionId: "app#bookkeeping", actionId, input })\`. Read each action's input schema first with \`integrations.actions({ connectionId: "app#bookkeeping" })\`, and never guess an input's fields.

When asked about a document:

1. \`documents.get\`, with input \`{ document: "<the document's ID>" }\`, gives its file's \`path\` and its status. Stop when it is not to book.
2. \`books.describe\` lists the journals, accounts, customers and suppliers, currencies, dimensions, and which periods are open.
3. Read the file with \`models.extract\` as \`/static/skills/extraction/SKILL.md\` describes: who issued it and to whom, its number, its dates, currency, each VAT rate's net and VAT amounts, and the total.
4. Look at recent entries in the journal you would book it in (\`entries.list\`), and book it as the books booked similar documents.
5. Propose the entry with \`documents.propose\`: purchases in the purchase journal and sales in the sales journal, posted on the document's date when its period is open, with the document's number as the reference. Lines on a supplier's or customer's account name them; leave the party null when the books lack them. In \`note\`, tell the person what the document is, how you chose the accounts, and what to check.

If the file is no invoice or receipt, or you cannot read it, call \`documents.decline\` with the reason instead. When an action refuses your proposal, fix what it names and propose again.`,
  permissions: ["upload.read", "models.extract", "integrations.read", "integrations.execute"],
  model: null,
};

/**
 * Why Backoffice did not do what was asked, for the person: unreachable, or its refusal, e.g. a
 * permission Bookkeeping lacks. Rethrows anything else.
 */
function backofficeProblem(error: unknown): string {
  if (isOutcomeUnknown(error)) {
    return "Backoffice could not be reached.";
  }
  if (error instanceof BackofficeApiRequestError && error.code !== null) {
    return error.message;
  }
  throw error;
}

const NOT_INSTALLED = "Bookkeeping is not installed for this administration's project.";

/**
 * Bookkeeping's installation in the administration's project, whose workspace holds the agent.
 * Bookkeeping prompts the agent as its installation, not as the person, so the agent's calls to
 * Bookkeeping can answer reviews and change nothing else, whatever a document tells it.
 */
async function connectToAgent(context: BooksContext) {
  const scope: BackofficeContextScope = {
    kind: "project",
    owner: { kind: "org", orgId: context.organization.id, jurisdiction: null },
    projectId: context.administration.id,
  };
  return { backoffice: await connectAsInstallation(scope), scope };
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
  document: Pick<DocumentView, "id" | "filename">,
  ask: "first" | "again",
): Promise<{ ok: true } | { ok: false; error: string }> {
  const requestId = `document:${document.id}:${ask === "first" ? "upload" : crypto.randomUUID()}`;
  const recorded = await context.books.reviewDocument({
    documentId: document.id,
    review: {
      status: "requested",
      requestId,
      by: context.user.name,
      at: new Date().toISOString(),
    },
    first: ask === "first",
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
    const { backoffice, scope } = await connectToAgent(context);
    if (!backoffice) {
      return { ok: false, error: NOT_INSTALLED };
    }
    try {
      await backoffice.call(scope, "pi.agent.create", BOOKKEEPER);
    } catch (error) {
      // It exists, perhaps as members changed it.
      if (!(error instanceof BackofficeApiRequestError && error.code === "conflict")) {
        throw error;
      }
    }
    // Each document is a subagent of its own: documents are read side by side, and no document
    // sees another's text.
    await backoffice.call(scope, "pi.prompt.submit", {
      agentName: BOOKKEEPER.agentName,
      requestId,
      subagent: true,
      content: `Propose the entry for document ${document.id} (${document.filename}).`,
    });
  } catch (error) {
    return { ok: false, error: `Backoffice did not ask the agent: ${backofficeProblem(error)}` };
  }
  return { ok: true };
}

/**
 * Where the agent stands with a request: Backoffice's answer, `lost` when the agent never received
 * it, or `unknown` with why Backoffice could not say.
 */
export type BookkeeperProgress =
  | PiPromptStatus
  | { status: "lost" }
  | { status: "unknown"; message: string };

export async function readBookkeeperProgress(
  context: BooksContext,
  requestId: string,
): Promise<BookkeeperProgress> {
  try {
    const { backoffice, scope } = await connectToAgent(context);
    if (!backoffice) {
      return { status: "unknown", message: NOT_INSTALLED };
    }
    const progress = await backoffice.call(scope, "pi.prompt.get", {
      agentName: BOOKKEEPER.agentName,
      requestId,
    });
    return progress ?? { status: "lost" };
  } catch (error) {
    return { status: "unknown", message: backofficeProblem(error) };
  }
}
