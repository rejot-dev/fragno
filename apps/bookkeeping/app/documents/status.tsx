import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import { Link } from "react-router";

import type { DocumentView } from "../../workers/books/documents/documents";
import { entryPath, indexBooks } from "../books/books";
import type { BooksOutletContext } from "../books/layout";

type Document = Pick<DocumentView, "source" | "state" | "review">;

/** The entries recording a document, named by their journal's code, e.g. `PUR 3`. */
export function documentEntries(document: Document, context: BooksOutletContext) {
  const { journals } = indexBooks(context.books);
  return (document.source?.entries ?? []).map((entry) => {
    // Entries post to the books' own journals.
    const journal = journals.get(entry.journalId)!;
    return {
      ...entry,
      name: `${journal.code} ${entry.entryNumber}`,
      path: entryPath(context.base, journal.code, entry.entryNumber),
    };
  });
}

/**
 * Whether a document is to book, with an entry the bookkeeping agent proposes or not; booked by an
 * entry it links to; or dismissed.
 */
export function DocumentStatus({
  document,
  context,
}: {
  document: Document;
  context: BooksOutletContext;
}) {
  const { state } = document;
  if (state.status === "to-book" && document.review?.status === "proposed") {
    return <BackofficeStatusLight tone="info">Entry proposed</BackofficeStatusLight>;
  }
  if (state.status === "to-book") {
    return <BackofficeStatusLight tone="waiting">To book</BackofficeStatusLight>;
  }
  if (state.status === "dismissed") {
    return <BackofficeStatusLight tone="muted">Dismissed</BackofficeStatusLight>;
  }
  const entry = documentEntries(document, context).find(({ id }) => id === state.entryId)!;
  return (
    <Link to={entry.path} className="hover:underline">
      <BackofficeStatusLight tone="live">Booked in {entry.name}</BackofficeStatusLight>
    </Link>
  );
}
