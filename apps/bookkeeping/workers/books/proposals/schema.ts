import { column, idColumn, schema, type Column } from "@fragno-dev/db/schema";

/**
 * The bookkeeping agent's proposal for something to book, from being asked to its answer: asked
 * under `requestId` and not answered yet, a `booking` it proposes, or why it proposes none.
 * Asking again replaces its answer. Times are ISO timestamps; `by` names the person the agent acted
 * for. A request is asked under a `generation` of the client's management, as the Directory
 * counts them.
 */
export type ProposalRequest = {
  status: "requested";
  requestId: string;
  generation: number;
  by: string;
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
