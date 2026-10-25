import type { AccountClassification, AccountRole, AccountType } from "@fragno-dev/ledger/schema";

import type { BooksOutletContext } from "./layout";

type Books = BooksOutletContext["books"];

/**
 * The books' accounts, journals, currencies, and party accounts by ID, for pages that show what
 * the ledger refers to by ID.
 */
export function indexBooks(books: Books) {
  return {
    accounts: new Map(books.accounts.map((account) => [account.id, account])),
    journals: new Map(books.journals.map((journal) => [journal.id, journal])),
    dimensionValues: new Map(
      books.dimensions.flatMap((dimension) =>
        dimension.values.map((value) => [value.id, { ...value, dimension }] as const),
      ),
    ),
    partyAccounts: new Map(
      books.parties.flatMap((party) =>
        party.accounts.map((account) => [account.id, { ...account, party }] as const),
      ),
    ),
    minorUnitDigits: (currency: string) =>
      // Lines and open items only ever carry the books' currencies.
      books.currencies.find((row) => row.code === currency)!.minorUnitDigits,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A calendar date as people read it, e.g. `31 Mar 2026` for `2026-03-31`. */
export function formatDate(date: string): string {
  const [year, month, day] = date.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

/** Two dates as a range, naming a shared year once, e.g. `1 Jan – 31 Mar 2026`. */
export function formatDateRange(start: string, end: string): string {
  const from = formatDate(start);
  return start.slice(0, 4) === end.slice(0, 4)
    ? `${from.slice(0, -5)} – ${formatDate(end)}`
    : `${from} – ${formatDate(end)}`;
}

/** The short month a date falls in, e.g. `Mar`. */
export function monthOf(date: string): string {
  return MONTHS[Number(date.slice(5, 7)) - 1];
}

/** The books' own path, which their pages extend. */
export function booksPath(params: { slug: string; administration: string }): string {
  return `/w/${params.slug}/a/${params.administration}`;
}

/** An entry's page; entries are named by their journal's code and number, e.g. `SAL 3`. */
export function entryPath(base: string, journalCode: string, entryNumber: number): string {
  return `${base}/entries/${encodeURIComponent(journalCode)}/${entryNumber}`;
}

/** `Code Name`, as accounts are named in lists and choices. */
export function accountLabel(account: { code: string; name: string }): string {
  return `${account.code} ${account.name}`;
}

/**
 * The kinds of account people choose from: an account type, and for assets and liabilities
 * whether customers or suppliers post to it.
 */
export const ACCOUNT_KINDS = {
  asset: { label: "Asset", classification: { type: "asset", role: "ordinary" } },
  receivable: {
    label: "Receivable (customers)",
    classification: { type: "asset", role: "receivable" },
  },
  liability: { label: "Liability", classification: { type: "liability", role: "ordinary" } },
  payable: {
    label: "Payable (suppliers)",
    classification: { type: "liability", role: "payable" },
  },
  equity: { label: "Equity", classification: { type: "equity", role: "ordinary" } },
  revenue: { label: "Revenue", classification: { type: "revenue", role: "ordinary" } },
  expense: { label: "Expense", classification: { type: "expense", role: "ordinary" } },
} as const satisfies Record<string, { label: string; classification: AccountClassification }>;

export type AccountKind = keyof typeof ACCOUNT_KINDS;

/** The kind an account was created as. */
export function accountKind(account: { type: AccountType; role: AccountRole }): AccountKind {
  return account.role === "ordinary" ? account.type : account.role;
}

/** How an account treats a dimension, as people choose it; no rule leaves it optional. */
export const DIMENSION_RULE_OPTIONS = [
  { label: "Optional", value: "optional" },
  { label: "Required", value: "required" },
  { label: "Not allowed", value: "forbidden" },
] as const;
