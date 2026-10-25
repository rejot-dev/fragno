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
