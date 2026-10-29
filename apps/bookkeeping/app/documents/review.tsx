import { Button } from "@fragno-private/design-system/button";
import { Callout } from "@fragno-private/design-system/callout";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import {
  SurfacePanelBody,
  SurfaceSection,
  SurfaceTable,
  SurfaceTableRow,
} from "@fragno-private/design-system/surface-panel";
import { useEffect } from "react";
import { Form, useNavigation, useRevalidator } from "react-router";

import type { DocumentView } from "../../workers/books/documents/documents";
import type { ProposedEntry } from "../../workers/books/documents/schema";
import { accountLabel, formatDate, indexBooks } from "../books/books";
import type { FormResult } from "../books/books.server";
import { FormError } from "../books/forms";
import type { BooksOutletContext } from "../books/layout";
import type { BookkeeperProgress } from "./bookkeeper.server";

/** The intent of the form asking the bookkeeping agent about the document. */
export const ASK = "ask";

// Nothing tells Bookkeeping when the agent's turn ends, so the page asks again until it has.
const PROGRESS_POLL_INTERVAL_MS = 5_000;

/** Reloads the page's data every few seconds while `working`, and the tab is in view. */
function usePollWhile(working: boolean) {
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
function requestState(progress: BookkeeperProgress): {
  tone: Tone;
  label: string;
  detail: string | null;
  askAgain: boolean;
} {
  switch (progress.status) {
    case "queued":
      return { tone: "waiting", label: "Waiting for the agent", detail: null, askAgain: false };
    case "running":
      return { tone: "live", label: "Reading the document", detail: null, askAgain: false };
    case "completed":
      return {
        tone: "failed",
        label: "The agent proposed nothing",
        detail:
          "It finished without proposing an entry or saying why. The firm keeping these books can read what it did in its Bookkeeping agent's conversation in Backoffice.",
        askAgain: true,
      };
    case "failed":
      return { tone: "failed", label: "The agent failed", detail: progress.reason, askAgain: true };
    case "lost":
      return {
        tone: "failed",
        label: "The agent was never asked",
        detail:
          "Backoffice did not receive the request, or could not set up the agent. Asking again says why.",
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

function ProposedLines({ entry, context }: { entry: ProposedEntry; context: BooksOutletContext }) {
  const { books } = context;
  const index = indexBooks(books);
  return (
    <SurfaceTable columns={LINE_COLUMNS}>
      {entry.lines.map((line, position) => {
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
 * What the bookkeeping agent made of a document to book: whether it was asked and how far it got,
 * the entry it proposes, or why it proposes none; and asking it (again).
 */
export function BookkeeperReview({
  document,
  progress,
  context,
  result,
}: {
  document: Pick<DocumentView, "review">;
  progress: BookkeeperProgress | null;
  context: BooksOutletContext;
  result: FormResult | undefined;
}) {
  const navigation = useNavigation();
  const { review } = document;
  usePollWhile(
    review?.status === "requested" &&
      (progress?.status === "queued" || progress?.status === "running"),
  );
  const ask = (label: string) => (
    <Form method="post">
      <input type="hidden" name="intent" value={ASK} />
      <Button type="submit" variant="secondary" disabled={navigation.state !== "idle"}>
        {label}
      </Button>
    </Form>
  );
  const answered = review === null ? null : formatDate(review.at.slice(0, 10));
  let body;
  let actions = null;
  if (review === null) {
    body = (
      <p className="text-sm text-[var(--bo-muted)]">
        The bookkeeping agent reads the document in Backoffice and proposes the entry booking it,
        for you to review.
      </p>
    );
    actions = ask("Ask the agent");
  } else if (review.status === "requested") {
    // Read when the page loads, for every request still waiting.
    const state = requestState(progress!);
    body = (
      <div className="space-y-2">
        <BackofficeStatusLight tone={state.tone}>{state.label}</BackofficeStatusLight>
        {state.detail === null ? null : (
          <p className="text-sm text-pretty text-[var(--bo-muted)]">{state.detail}</p>
        )}
      </div>
    );
    actions = state.askAgain ? ask("Ask again") : null;
  } else if (review.status === "withdrawn") {
    body = (
      <Callout tone="waiting" title="The request was withdrawn">
        {review.reason}
      </Callout>
    );
    actions = ask("Ask again");
  } else if (review.status === "declined") {
    body = (
      <Callout tone="waiting" title="The agent proposes no entry">
        {review.reason}
      </Callout>
    );
    actions = ask("Ask again");
  } else {
    body = (
      <div className="space-y-3">
        <Callout tone="info" title="Proposed entry">
          {review.note}
        </Callout>
        <p className="text-sm text-[var(--bo-muted)]">
          {review.entry.description}
          {review.entry.reference === null ? "" : ` · ${review.entry.reference}`} · posted{" "}
          {formatDate(review.entry.postingDate)}, document dated{" "}
          {formatDate(review.entry.documentDate)}. Review and book fills the new entry in from it.
        </p>
      </div>
    );
    actions = ask("Ask again");
  }
  return (
    <SurfaceSection title="Bookkeeping agent" meta={answered} actions={actions}>
      <SurfacePanelBody>
        {body}
        <FormError result={result} intent={ASK} />
      </SurfacePanelBody>
      {review?.status === "proposed" ? (
        <ProposedLines entry={review.entry} context={context} />
      ) : null}
    </SurfaceSection>
  );
}
