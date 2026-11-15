import type { TxResult } from "@fragno-dev/db";
import type { createLedgerFragment } from "@fragno-dev/ledger";

type LedgerServices = ReturnType<typeof createLedgerFragment>["services"];
type Result<T> = T extends TxResult<infer TResult, infer _TRetrieved> ? TResult : never;

/** A ledger source document, such as a document or a bank transaction, with its entries. */
export type SourceDocument = Result<ReturnType<LedgerServices["getSourceDocuments"]>>[number];
export type SourceEntry = SourceDocument["entries"][number];

/**
 * Whether an entry books its source document: an entry recording it does, its reversal undoes
 * that, and reversing the reversal books it again. A reversal records its entry's source document,
 * so the whole chain is among the source document's entries.
 */
export function booksSource(entry: SourceEntry, source: SourceDocument): boolean {
  let books = true;
  let current = entry;
  while (current.reversesEntryId !== null) {
    const reversed = current.reversesEntryId;
    books = !books;
    current = source.entries.find((candidate) => candidate.id === reversed)!;
  }
  return books;
}

/** The entry booking a source document now, or null while none does. */
export function bookingEntry(source: SourceDocument | null): SourceEntry | null {
  return (
    source?.entries.find(
      (entry) => entry.reversedByEntryId === null && booksSource(entry, source),
    ) ?? null
  );
}
