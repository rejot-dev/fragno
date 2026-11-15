import type { TransactionView } from "../../workers/books/banking/banking";
import type { Books } from "../../workers/books/books";
import { parseAmount } from "../../workers/books/money";
import type { requireBooks } from "../books/books.server";

/**
 * How a bank transaction to book is likely paid: by or to which customer or supplier, settling
 * which of their open items, as the payment form starts.
 */

type Context = Awaited<ReturnType<typeof requireBooks>>;
type Described = Awaited<ReturnType<Books["describe"]>>;
type OpenItem = Awaited<ReturnType<Books["listOpenItems"]>>[number];

/** A name as compared with another: lowercase letters and digits, without legal forms. */
function comparable(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(b\.?v\.?|n\.?v\.?|v\.?o\.?f\.?|ltd|inc|gmbh|llc)\b/gu, "")
    .replace(/[^a-z0-9]/gu, "");
}

/**
 * The customers and suppliers the transaction is likely with: those its counterparty's IBAN paid
 * or was paid by before, then those named like it. Customers come first for money in, suppliers
 * for money out.
 */
function suggestPartyAccounts(
  transaction: TransactionView,
  books: Described,
  learned: readonly string[],
): string[] {
  const names =
    transaction.detail.type === "entry"
      ? transaction.detail.parts.flatMap((part) =>
          part.name === null ? [] : comparable(part.name),
        )
      : [];
  const named = books.parties.filter((party) => {
    const name = comparable(party.name);
    return (
      name.length >= 3 &&
      names.some(
        (candidate) =>
          candidate.length >= 3 && (candidate.includes(name) || name.includes(candidate)),
      )
    );
  });
  const role = transaction.amountMinor > 0n ? "customer" : "supplier";
  const byRole = named
    .flatMap((party) => party.accounts)
    .sort((a, b) => Number(b.role === role) - Number(a.role === role))
    .map((account) => account.id);
  const exists = new Set(books.parties.flatMap((party) => party.accounts.map(({ id }) => id)));
  return [...new Set([...learned.filter((id) => exists.has(id)), ...byRole])];
}

/**
 * Whether `text` names `reference` whole: not as part of a longer one, as `INV-10` holds `INV-1`.
 * Case and runs of spaces do not count.
 */
function names(text: string, reference: string): boolean {
  const said = text.toUpperCase().replace(/\s+/gu, " ");
  const wanted = reference.toUpperCase().replace(/\s+/gu, " ").trim();
  const alphanumeric = (character: string | undefined) =>
    character !== undefined && /[\p{L}\p{N}]/u.test(character);
  for (let at = said.indexOf(wanted); at !== -1; at = said.indexOf(wanted, at + 1)) {
    if (!alphanumeric(said[at - 1]) && !alphanumeric(said[at + wanted.length])) {
      return wanted !== "";
    }
  }
  return false;
}

/** The side of the open items a payment settles: invoices for money in, bills for money out. */
function settledSide(transaction: { amountMinor: bigint }): "debit" | "credit" {
  return transaction.amountMinor > 0n ? "debit" : "credit";
}

/**
 * The open items the transaction settles to start with, with how much of each: those whose
 * reference its description names, else the first owing exactly its amount; each for what it has
 * outstanding, within the transaction's amount.
 */
function preselect(transaction: TransactionView, items: OpenItem[]): Map<string, bigint> {
  const { detail } = transaction;
  const said =
    detail.type === "entry"
      ? [...detail.parts.map((part) => part.remittance), detail.information].join(" ")
      : "";
  const amount = transaction.amountMinor > 0n ? transaction.amountMinor : -transaction.amountMinor;
  const named = items.filter(
    (item) => item.entry.reference !== null && names(said, item.entry.reference),
  );
  const exact = items.find((item) => item.outstandingMinor === amount);
  const chosen = named.length > 0 ? named : exact ? [exact] : [];
  const amounts = new Map<string, bigint>();
  let left = amount;
  for (const item of chosen) {
    const settled = item.outstandingMinor < left ? item.outstandingMinor : left;
    if (settled > 0n) {
      amounts.set(item.id, settled);
      left -= settled;
    }
  }
  return amounts;
}

/** The open items of `partyAccountId` the transaction can settle: in its currency, on the other side. */
export async function settleableItems(
  context: Context,
  transaction: TransactionView,
  partyAccountId: string,
) {
  const items = await context.books.listOpenItems({ partyAccountId });
  return items.filter(
    (item) =>
      item.outstandingMinor > 0n &&
      item.side === settledSide(transaction) &&
      item.currency === transaction.bankAccount.currency,
  );
}

/** How the payment form starts for a transaction to book. */
export type PaymentSuggestion = {
  /** The customers' and suppliers' accounts it is likely with, likeliest first. */
  suggested: string[];
  /** The account the form shows the open items of. */
  partyAccountId: string | null;
  items: OpenItem[];
  /** How much of each open item it settles to start with, by the item's ID. */
  preselected: Record<string, bigint>;
};

/**
 * How the payment form starts for `transaction`: with the customer or supplier `chosen`, else the
 * one the bookkeeping agent proposes it pays, else the likeliest; settling what the agent proposes
 * of theirs, else what the books suggest.
 */
export async function suggestPayment(
  context: Context,
  transaction: TransactionView,
  books: Described,
  chosen: string | null,
): Promise<PaymentSuggestion> {
  const { detail, proposal } = transaction;
  const ibans =
    detail.type === "entry" ? [...new Set(detail.parts.flatMap((part) => part.iban ?? []))] : [];
  const learned = ibans.length === 1 ? await context.books.counterpartiesOf(ibans[0]) : [];
  const suggested = suggestPartyAccounts(transaction, books, learned);
  const partyAccounts = new Set(
    books.parties.flatMap((party) => party.accounts.map(({ id }) => id)),
  );
  const payment =
    proposal?.status === "proposed" &&
    proposal.booking.type === "payment" &&
    partyAccounts.has(proposal.booking.partyAccountId)
      ? proposal.booking
      : null;
  const partyAccountId =
    chosen !== null && partyAccounts.has(chosen)
      ? chosen
      : (payment?.partyAccountId ?? suggested[0] ?? null);
  const items =
    partyAccountId === null ? [] : await settleableItems(context, transaction, partyAccountId);
  if (payment === null || payment.partyAccountId !== partyAccountId) {
    return {
      suggested,
      partyAccountId,
      items,
      preselected: Object.fromEntries(preselect(transaction, items)),
    };
  }
  const digits = books.currencies.find(
    (currency) => currency.code === transaction.bankAccount.currency,
  )!.minorUnitDigits;
  return {
    suggested,
    partyAccountId,
    items,
    // The agent's amounts were checked as it proposed them; items settled since are left out.
    preselected: Object.fromEntries(
      payment.settles
        .filter((settlement) => items.some((item) => item.id === settlement.openItemId))
        .map((settlement) => [settlement.openItemId, parseAmount(settlement.amount, digits)!]),
    ),
  };
}

/** Whether the payment form, as it starts, books the whole transaction as settling what it pays. */
export function settlesWhole(transaction: { amountMinor: bigint }, suggestion: PaymentSuggestion) {
  const paid = transaction.amountMinor > 0n ? transaction.amountMinor : -transaction.amountMinor;
  const settled = Object.values(suggestion.preselected).reduce((sum, amount) => sum + amount, 0n);
  return suggestion.partyAccountId !== null && settled === paid;
}
