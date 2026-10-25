import type { ReactNode } from "react";
import { Link } from "react-router";

import type { Books } from "../../workers/books/books";
import { formatAmount } from "../../workers/books/money";
import { AccountName } from "./amounts";
import type { indexBooks } from "./books";
import type { BooksOutletContext } from "./layout";

type Line = NonNullable<Awaited<ReturnType<Books["getEntry"]>>>["lines"][number];

/** The columns an entry's lines show in, in the journal and on the entry's page. */
export const LINE_COLUMNS = [
  { label: "Account", align: "start" },
  { label: "Details", align: "start" },
  { label: "Debit", align: "end" },
  { label: "Credit", align: "end" },
] as const;

/**
 * A line's cells: its account, what else it carries (party, description, foreign amount,
 * dimensions), and its functional amount on its side.
 */
export function lineCells(
  line: Line,
  { books, base }: Pick<BooksOutletContext, "books" | "base">,
  index: ReturnType<typeof indexBooks>,
): ReactNode[] {
  const account = index.accounts.get(line.accountId)!;
  const partyAccount = line.openItem && index.partyAccounts.get(line.openItem.partyAccountId)!;
  const amount = formatAmount(
    line.functionalAmountMinor,
    index.minorUnitDigits(books.functionalCurrency),
  );
  const foreign =
    line.currency === books.functionalCurrency
      ? null
      : `${line.currency} ${formatAmount(line.amountMinor, index.minorUnitDigits(line.currency))}`;
  const details = [
    partyAccount && `${partyAccount.party.name} (${partyAccount.code})`,
    line.description,
    foreign,
    ...line.dimensionValueIds.map((valueId) => index.dimensionValues.get(valueId)!.name),
  ].filter((part) => part !== null && part !== "");
  return [
    <Link
      key="account"
      to={`${base}/accounts/${account.id}`}
      className="inline-block min-w-56 text-[var(--bo-fg)] hover:underline"
    >
      <AccountName account={account} />
    </Link>,
    details.join(" · "),
    // Fixed widths line the amounts of every entry up.
    <span key="debit" className="inline-block min-w-24">
      {line.side === "debit" ? amount : ""}
    </span>,
    <span key="credit" className="inline-block min-w-24">
      {line.side === "credit" ? amount : ""}
    </span>,
  ];
}
