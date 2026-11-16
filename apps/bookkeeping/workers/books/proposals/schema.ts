import { column, idColumn, schema, type Column } from "@fragno-dev/db/schema";

/**
 * What a request is about, as the firm's people read it: the document's file name or the bank
 * transaction's description, and the client and administration whose books hold it.
 */
export type RequestAbout = { title: string; client: string; administration: string };

/**
 * The bookkeeping agent's proposal for something to book, from being asked to its answer: asked
 * under `requestId` and not answered yet, a `booking` it proposes, or why it proposes none.
 * Asking again replaces its answer. Times are ISO timestamps; `by` names the person the agent acted
 * for. A request is asked of the agent of `firmId`, under a `generation` of the client's management,
 * as the Directory counts them. It is `announced` once the books told the firm of it: a
 * transaction's as it is asked, a document's once its file is shared with the firm.
 */
export type ProposalRequest = {
  status: "requested";
  requestId: string;
  about: RequestAbout;
  generation: number;
  firmId: string;
  announced: boolean;
  by: string;
  at: string;
};

/**
 * A change to a request the firm was told of, which the books tell the firm in turn: the request,
 * with `prompt`, what its agent is asked, or how it ended. Its subject has one at a time, so the
 * firm keeps each subject's latest as what it is to do.
 */
export type RequestChange = {
  subjectId: string;
  requestId: string;
  about: RequestAbout;
  firmId: string;
  status: "requested" | "proposed" | "declined" | "withdrawn";
  prompt: string | null;
  at: string;
};

export type ProposalAnswer<TBooking> =
  | { status: "proposed"; booking: TBooking; note: string; by: string; at: string }
  | { status: "declined"; reason: string; by: string; at: string };

/** A request withdrawn unanswered, e.g. when the firm asked no longer keeps the books. */
export type ProposalWithdrawal = { status: "withdrawn"; reason: string; at: string };

export type AgentProposal<TBooking> =
  | ProposalRequest
  | ProposalAnswer<TBooking>
  | ProposalWithdrawal;

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

function jsonColumn<T>() {
  return column("json") as unknown as Column<"json", T, T>;
}

/**
 * The bookkeeping agent's proposals for booking what the books are to book, such as documents and
 * bank transactions. A proposal's ID is its subject's, the ID of the source document whose entries
 * book it, which is unique across kinds. Only the subject's own fragment reads its booking.
 */
export const proposalsSchema = schema("proposals", (s) => {
  return (
    s
      .addTable("proposal", (t) =>
        t.addColumn("id", idColumn()).addColumn("proposal", jsonColumn<AgentProposal<unknown>>()),
      )
      // Its one row holds the latest generation of the client's management these books heard of. A
      // request asked under an earlier one is refused: its firm may have been withdrawn already.
      .addTable("management", (t) =>
        t.addColumn("id", idColumn()).addColumn("generation", column("integer")),
      )
  );
});
