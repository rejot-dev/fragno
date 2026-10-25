import type { AccountClassification, Side } from "@fragno-dev/ledger/schema";

/** The journals new books open with: one per kind of bookkeeping a business does every month. */
export const DEFAULT_JOURNALS = [
  { code: "GEN", name: "General" },
  { code: "SAL", name: "Sales" },
  { code: "PUR", name: "Purchases" },
  { code: "BNK", name: "Bank" },
] as const;

type DefaultAccount = {
  code: string;
  name: string;
  classification: AccountClassification;
  normalSide: Side;
};

/**
 * A small chart of accounts to start from, numbered so related accounts sort together: balance
 * sheet accounts first, then expenses, then revenue. Businesses add the accounts they need.
 */
export const DEFAULT_ACCOUNTS: readonly DefaultAccount[] = [
  {
    code: "0500",
    name: "Equity",
    classification: { type: "equity", role: "ordinary" },
    normalSide: "credit",
  },
  {
    code: "1000",
    name: "Bank",
    classification: { type: "asset", role: "ordinary" },
    normalSide: "debit",
  },
  {
    code: "1300",
    name: "Accounts receivable",
    classification: { type: "asset", role: "receivable" },
    normalSide: "debit",
  },
  {
    code: "1500",
    name: "VAT receivable",
    classification: { type: "asset", role: "ordinary" },
    normalSide: "debit",
  },
  {
    code: "1600",
    name: "Accounts payable",
    classification: { type: "liability", role: "payable" },
    normalSide: "credit",
  },
  {
    code: "1700",
    name: "VAT payable",
    classification: { type: "liability", role: "ordinary" },
    normalSide: "credit",
  },
  {
    code: "4000",
    name: "General expenses",
    classification: { type: "expense", role: "ordinary" },
    normalSide: "debit",
  },
  {
    code: "7000",
    name: "Cost of sales",
    classification: { type: "expense", role: "ordinary" },
    normalSide: "debit",
  },
  {
    code: "8000",
    name: "Revenue",
    classification: { type: "revenue", role: "ordinary" },
    normalSide: "credit",
  },
];
