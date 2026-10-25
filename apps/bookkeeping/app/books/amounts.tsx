import { formatAmount } from "../../workers/books/money";

/**
 * A signed balance: the amount, then `Dr` when debits exceed credits or `Cr` when credits do.
 * Zero has no side.
 */
export function Balance({ minor, digits }: { minor: bigint; digits: number }) {
  return (
    <>
      {formatAmount(minor < 0n ? -minor : minor, digits)}
      <span className="ml-1 inline-block w-5 text-left text-xs text-[var(--bo-muted-2)]">
        {minor === 0n ? "" : minor > 0n ? "Dr" : "Cr"}
      </span>
    </>
  );
}

/** An account as lists show it: its code, quieter, then its name. */
export function AccountName({ account }: { account: { code: string; name: string } }) {
  return (
    <>
      <span className="mr-2 text-[var(--bo-muted-2)] tabular-nums">{account.code}</span>
      {account.name}
    </>
  );
}
