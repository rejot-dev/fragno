import { BackofficeStatusLight } from "@fragno-private/design-system/feedback/status-light";
import { Link } from "react-router";

import type { TransactionState } from "../../workers/books/banking/banking";
import { formatAmount } from "../../workers/books/money";
import type { SourceDocument } from "../../workers/books/sources";
import { entryPath, indexBooks } from "../books/books";
import type { BooksOutletContext } from "../books/layout";

/** An amount with its sign, as banks print it: money out and overdrawn balances are negative. */
export function SignedAmount({ minor, digits }: { minor: bigint; digits: number }) {
  return (
    <span className={`tabular-nums ${minor > 0n ? "text-[var(--bo-live)]" : ""}`}>
      {minor < 0n ? "−" : ""}
      {formatAmount(minor < 0n ? -minor : minor, digits)}
    </span>
  );
}

/** The entries recording a transaction, named by their journal's code, e.g. `BNK 3`. */
export function transactionEntries(source: SourceDocument | null, context: BooksOutletContext) {
  const { journals } = indexBooks(context.books);
  return (source?.entries ?? []).map((entry) => {
    // Entries post to the books' own journals.
    const journal = journals.get(entry.journalId)!;
    return {
      ...entry,
      name: `${journal.code} ${entry.entryNumber}`,
      path: entryPath(context.base, journal.code, entry.entryNumber),
    };
  });
}

/** Whether a transaction is to book, or booked by an entry it links to. */
export function TransactionStatus({
  transaction,
  context,
}: {
  transaction: { source: SourceDocument | null; state: TransactionState };
  context: BooksOutletContext;
}) {
  const { state } = transaction;
  if (state.status === "to-book") {
    return <BackofficeStatusLight tone="waiting">To book</BackofficeStatusLight>;
  }
  const entry = transactionEntries(transaction.source, context).find(
    ({ id }) => id === state.entryId,
  )!;
  return (
    <Link to={entry.path} className="hover:underline">
      <BackofficeStatusLight tone="live">Booked in {entry.name}</BackofficeStatusLight>
    </Link>
  );
}
