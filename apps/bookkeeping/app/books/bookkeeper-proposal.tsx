import { Button } from "@fragno-private/design-system/controls/button";
import { Callout } from "@fragno-private/design-system/feedback/callout";
import { BackofficeStatusLight } from "@fragno-private/design-system/feedback/status-light";
import { Icon } from "@fragno-private/design-system/icon";
import {
  SurfacePanelBody,
  SurfaceSection,
  SurfaceTable,
  SurfaceTableRow,
} from "@fragno-private/design-system/layout/surface-panel";
import { useEffect, type ReactNode } from "react";
import { Form, useNavigation, useRevalidator } from "react-router";

import type { ProposedLine, AgentProposal } from "../../workers/books/proposals/schema";
import { agentStepLine, type AgentStep } from "./agent-steps";
import type { BookkeeperProgress } from "./bookkeeper.server";
import { accountLabel, formatDate, indexBooks } from "./books";
import type { FormResult } from "./books.server";
import { FormError } from "./forms";
import type { BooksOutletContext } from "./layout";

/** The intent of the form asking the bookkeeping agent about what the page shows. */
export const ASK = "ask";

/** How the panel speaks of what it is about, and of what the agent proposes for it. */
const WORDING = {
  document: {
    reads: "reads the document in Backoffice and proposes the entry booking it",
    reading: "Reading the document",
    proposal: "an entry",
    none: "The agent proposes no entry",
  },
  transaction: {
    reads: "reads the bank transaction and proposes how to book it",
    reading: "Reading the bank transaction",
    proposal: "a booking",
    none: "The agent proposes no booking",
  },
} as const;

type Subject = keyof typeof WORDING;

// Nothing tells Bookkeeping when the agent's turn ends, so the page asks again until it has.
const PROGRESS_POLL_INTERVAL_MS = 5_000;

/** Reloads the page's data every few seconds while `working`, and the tab is in view. */
export function usePollWhile(working: boolean) {
  const revalidator = useRevalidator();
  const navigation = useNavigation();
  const idle = revalidator.state === "idle" && navigation.state === "idle";
  useEffect(() => {
    if (!working || !idle) {
      return undefined;
    }
    const timer = setInterval(() => {
      if (window.document.visibilityState === "visible") {
        void revalidator.revalidate();
      }
    }, PROGRESS_POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [working, idle, revalidator]);
}

type Tone = Parameters<typeof BackofficeStatusLight>[0]["tone"];

const LINE_COLUMNS = [
  { label: "Account", align: "start" },
  { label: "Details", align: "start" },
  { label: "Debit", align: "end" },
  { label: "Credit", align: "end" },
] as const;

/** What a request still waiting for its answer says, by where the agent stands with it. */
function requestState(
  progress: BookkeeperProgress,
  subject: Subject,
): {
  tone: Tone;
  label: string;
  detail: string | null;
  askAgain: boolean;
} {
  switch (progress.status) {
    case "queued":
      return { tone: "waiting", label: "Waiting for the agent", detail: null, askAgain: false };
    case "running":
      return { tone: "live", label: WORDING[subject].reading, detail: null, askAgain: false };
    case "completed":
      return {
        tone: "failed",
        label: "The agent proposed nothing",
        detail: `It finished without proposing ${WORDING[subject].proposal} or saying why. The firm keeping these books can read what it did in its Bookkeeping agent's conversation in Backoffice.`,
        askAgain: true,
      };
    case "failed":
      return { tone: "failed", label: "The agent failed", detail: progress.reason, askAgain: true };
    case "unsent":
      return {
        tone: "failed",
        label: "The agent was never asked",
        detail:
          "Bookkeeping could not hand the request to the firm's agent. Asking again says why.",
        askAgain: true,
      };
    case "sending":
      return { tone: "waiting", label: "Asking the agent", detail: null, askAgain: false };
    case "undelivered":
      return {
        tone: "failed",
        label: "The agent was never asked",
        detail: `Backoffice did not take the request: ${progress.reason}`,
        askAgain: true,
      };
    case "waiting":
      return {
        tone: "waiting",
        label: "Waiting for the agent",
        detail: "The firm's bookkeeping agent starts on the requests it is given in turn.",
        askAgain: true,
      };
    case "unknown":
      return {
        tone: "muted",
        label: "Asked the agent",
        detail: `Backoffice could not say how far it got: ${progress.message}`,
        askAgain: true,
      };
  }
  throw new Error("Unsupported bookkeeper progress.");
}

/** The agent's work so far, oldest first, one line per step. */
function BookkeeperSteps({ steps }: { steps: AgentStep[] }) {
  return (
    <ol className="space-y-1 text-sm">
      {steps.map((step, position) => {
        const { label, detail, state } = agentStepLine(step);
        const running = state === "running";
        const failed = state === "failed";
        return (
          // Steps have no IDs, and a step keeps its place as the work goes on.
          <li key={position} className="flex items-center gap-2">
            <Icon
              name={failed ? "x" : running ? "loader" : "check"}
              className={
                failed
                  ? "size-3.5 text-[var(--bo-failed)]"
                  : running
                    ? "size-3.5 animate-spin text-[var(--bo-accent)]"
                    : "size-3.5 text-[var(--bo-muted)]"
              }
            />
            <span className={running ? "text-[var(--bo-fg)]" : "text-[var(--bo-muted)]"}>
              {label}
            </span>
            {detail === null ? null : (
              <span className="font-mono text-xs text-[var(--bo-muted-2)]">{detail}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The lines of an entry the bookkeeping agent proposes. */
export function ProposedLines({
  lines,
  context,
}: {
  lines: ProposedLine[];
  context: BooksOutletContext;
}) {
  const { books } = context;
  const index = indexBooks(books);
  return (
    <SurfaceTable columns={LINE_COLUMNS}>
      {lines.map((line, position) => {
        const account = index.accounts.get(line.accountId);
        const partyAccount =
          line.partyAccountId === null ? null : index.partyAccounts.get(line.partyAccountId);
        const amount =
          line.currency === books.functionalCurrency
            ? line.functionalAmount
            : `${line.currency} ${line.amount} (${line.functionalAmount})`;
        const details = [
          partyAccount && `${partyAccount.party.name} (${partyAccount.code})`,
          line.description,
          ...line.dimensionValueIds.map((valueId) => index.dimensionValues.get(valueId)?.name),
        ].filter((part) => typeof part === "string" && part !== "");
        return (
          <SurfaceTableRow
            // Proposed lines have no IDs, and the proposal never changes in place.
            key={position}
            columns={LINE_COLUMNS}
            cells={[
              account ? accountLabel(account) : "An account the books no longer have",
              details.join(" · "),
              <span key="debit" className="tabular-nums">
                {line.side === "debit" ? amount : ""}
              </span>,
              <span key="credit" className="tabular-nums">
                {line.side === "credit" ? amount : ""}
              </span>,
            ]}
          />
        );
      })}
    </SurfaceTable>
  );
}

/**
 * What the bookkeeping agent made of a document or a bank transaction to book: whether it was asked
 * and how far it got, what it proposes, which the page renders as `proposed`, or why it proposes
 * nothing; and asking it (again).
 */
export function BookkeeperProposal({
  subject,
  proposal,
  progress,
  proposed,
  result,
}: {
  subject: Subject;
  proposal: AgentProposal<unknown> | null;
  progress: BookkeeperProgress | null;
  proposed: ReactNode;
  result: FormResult | undefined;
}) {
  const navigation = useNavigation();
  usePollWhile(
    proposal?.status === "requested" &&
      ["sending", "waiting", "queued", "running"].includes(progress?.status ?? ""),
  );
  const ask = (label: string) => (
    <Form method="post">
      <input type="hidden" name="intent" value={ASK} />
      <Button type="submit" variant="secondary" disabled={navigation.state !== "idle"}>
        {label}
      </Button>
    </Form>
  );
  const answered = proposal === null ? null : formatDate(proposal.at.slice(0, 10));
  let body;
  let actions = null;
  if (proposal === null) {
    body = (
      <p className="text-sm text-[var(--bo-muted)]">
        The bookkeeping agent {WORDING[subject].reads}, for you to review.
      </p>
    );
    actions = ask("Ask the agent");
  } else if (proposal.status === "requested") {
    // Read when the page loads, for every request still waiting.
    const state = requestState(progress!, subject);
    const steps = "steps" in progress! ? progress.steps : [];
    body = (
      <div className="space-y-2">
        <BackofficeStatusLight tone={state.tone}>{state.label}</BackofficeStatusLight>
        {state.detail === null ? null : (
          <p className="text-sm text-pretty text-[var(--bo-muted)]">{state.detail}</p>
        )}
        {steps.length > 0 ? <BookkeeperSteps steps={steps} /> : null}
      </div>
    );
    actions = state.askAgain ? ask("Ask again") : null;
  } else if (proposal.status === "withdrawn") {
    body = (
      <Callout tone="waiting" title="The request was withdrawn">
        {proposal.reason}
      </Callout>
    );
    actions = ask("Ask again");
  } else if (proposal.status === "declined") {
    body = (
      <Callout tone="waiting" title={WORDING[subject].none}>
        {proposal.reason}
      </Callout>
    );
    actions = ask("Ask again");
  } else {
    actions = ask("Ask again");
  }
  const asking = result?.intent === ASK && result.error !== null;
  return (
    <SurfaceSection title="Bookkeeping agent" meta={answered} actions={actions}>
      {/* What the agent proposes renders panels of its own, such as a table of lines. */}
      {body === undefined ? proposed : <SurfacePanelBody>{body}</SurfacePanelBody>}
      {asking ? (
        <SurfacePanelBody>
          <FormError result={result} intent={ASK} />
        </SurfacePanelBody>
      ) : null}
    </SurfaceSection>
  );
}
