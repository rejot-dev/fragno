import { column, idColumn, schema, type Column } from "@fragno-dev/db/schema";

/** The kinds of file a document can be: what people scan and photograph, never markup. */
export const DOCUMENT_MEDIA_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
export type DocumentMediaType = (typeof DOCUMENT_MEDIA_TYPES)[number];

/** Who dismissed a document and when, as an ISO timestamp. */
export type Dismissal = { by: string; at: string };

/** A line of a proposed entry, as the new-entry form takes it: amounts are decimals. */
export type ProposedLine = {
  accountId: string;
  description: string;
  side: "debit" | "credit";
  amount: string;
  currency: string;
  /** The amount in the books' functional currency; the amount itself for lines in it. */
  functionalAmount: string;
  /** Null on accounts of no customer or supplier, and where the agent found none in the books. */
  partyAccountId: string | null;
  dueDate: string | null;
  dimensionValueIds: string[];
};

/** The entry the bookkeeping agent proposes to book a document with, naming the books' records by ID. */
export type ProposedEntry = {
  journalId: string;
  postingDate: string;
  documentDate: string;
  reference: string | null;
  description: string;
  lines: ProposedLine[];
};

/**
 * What the bookkeeping agent made of a document: asked under `requestId` and not answered yet, an
 * entry it proposes, or why it proposes none. Asking again replaces its answer. Times are ISO
 * timestamps; `by` names the person the agent acted for.
 */
export type ReviewRequest = { status: "requested"; requestId: string; by: string; at: string };

export type ReviewAnswer =
  | { status: "proposed"; entry: ProposedEntry; note: string; by: string; at: string }
  | { status: "declined"; reason: string; by: string; at: string };

/** A request withdrawn unanswered, e.g. when the firm asked no longer keeps the books. */
export type ReviewWithdrawal = { status: "withdrawn"; reason: string; at: string };

export type Review = ReviewRequest | ReviewAnswer | ReviewWithdrawal;

function stringColumn<T extends string>() {
  return column("string") as unknown as Column<"string", T, T>;
}

function jsonColumn<T>() {
  return column("json") as unknown as Column<"json", T, T>;
}

/**
 * The documents uploaded to an administration's books, such as invoices and receipts. The bytes
 * live elsewhere, under `storageKey`, which only the application interprets; `sha256` tells when
 * they changed there. Whether a document is booked is the ledger's: its ID is the ID of the source
 * document its entries record.
 */
export const documentsSchema = schema("documents", (s) => {
  return (
    s
      .addTable("document", (t) => {
        return (
          t
            .addColumn("id", idColumn())
            .addColumn("filename", column("string"))
            .addColumn("mediaType", stringColumn<DocumentMediaType>())
            .addColumn("sizeBytes", column("integer"))
            .addColumn("sha256", column("string"))
            .addColumn("storageKey", column("string"))
            .addColumn("uploadedAt", column("timestamp"))
            .addColumn("uploadedBy", column("string"))
            // Claimed by each booking, reversing a reversal included, as entries claim their journal's
            // numbers, so two bookings of a document at once conflict instead of both posting.
            .addColumn("bookings", column("integer"))
            .addColumn("dismissal", jsonColumn<Dismissal | null>().nullable())
            .createIndex("idx_document_uploaded", ["uploadedAt"])
        );
      })
      // Null until someone asks the bookkeeping agent about the document.
      .alterTable("document", (t) => t.addColumn("review", jsonColumn<Review | null>().nullable()))
      // Whether the file may still be shared with a firm's bookkeeping agent: set by each request,
      // cleared once its shares are revoked. Documents from before it was recorded may be shared.
      .alterTable("document", (t) => t.addColumn("shared", column("bool").defaultTo(true)))
  );
});
