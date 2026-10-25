import { Select } from "@fragno-private/design-system/select";
import {
  SurfacePanel,
  SurfaceTable,
  SurfaceTableRow,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { Link, useNavigate, useOutletContext } from "react-router";

import { today } from "../../workers/books/fiscal-years";
import { formatAmount } from "../../workers/books/money";
import type { Route } from "./+types/trial-balance";
import { indexBooks } from "./books";
import { requireBooks } from "./books.server";
import type { BooksOutletContext } from "./layout";

export function meta() {
  return [{ title: "Trial balance · Bookkeeping" }];
}

/**
 * Each account's totals from the start of a fiscal year through one of its periods: `?period=`,
 * else the period today falls in, else the books' last period.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { books } = await requireBooks(request, params);
  const { fiscalYears } = await books.describe();
  const periods = fiscalYears.flatMap((year) => year.periods);
  const requested = new URL(request.url).searchParams.get("period");
  const date = today();
  const period =
    periods.find((row) => row.id === requested) ??
    periods.find((row) => row.startDate <= date && date <= row.endDate) ??
    periods.at(-1);
  if (!period) {
    return { periodId: null, rows: [] };
  }
  return { periodId: period.id, rows: await books.getTrialBalance({ periodId: period.id }) };
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

const COLUMNS = [
  { label: "Code", align: "start" },
  { label: "Account", align: "start" },
  { label: "Debit", align: "end" },
  { label: "Credit", align: "end" },
  { label: "Balance", align: "end" },
] as const;

export default function TrialBalancePage({ loaderData }: Route.ComponentProps) {
  const { books, base } = useOutletContext<BooksOutletContext>();
  const navigate = useNavigate();
  const { periodId, rows } = loaderData;
  if (periodId === null) {
    return (
      <BackofficeSystemState
        tone="empty"
        label="Trial balance"
        title="No fiscal years yet"
        description="Open a fiscal year in the books' settings to post and report."
      />
    );
  }
  const digits = indexBooks(books).minorUnitDigits(books.functionalCurrency);
  const amount = (minor: bigint) => formatAmount(minor, digits);
  const balance = (minor: bigint) =>
    minor === 0n
      ? amount(0n)
      : `${amount(minor > 0n ? minor : -minor)} ${minor > 0n ? "Dr" : "Cr"}`;
  const debits = rows.reduce((sum, row) => sum + row.debitMinor, 0n);
  const credits = rows.reduce((sum, row) => sum + row.creditMinor, 0n);
  const periodOptions = books.fiscalYears.flatMap((year) =>
    year.periods.map((period) => ({
      label: `${year.name} · period ${period.number} (through ${period.endDate})`,
      value: period.id,
    })),
  );
  const year = books.fiscalYears.find((row) =>
    row.periods.some((period) => period.id === periodId),
  )!;
  return (
    <SurfacePanel
      caption={`Trial balance in ${books.functionalCurrency} · from ${year.startDate}`}
      actions={
        <div className="w-80">
          <Select
            aria-label="Through period"
            density="compact"
            options={periodOptions}
            value={periodId}
            onValueChange={(period) => {
              if (period !== null) {
                void navigate(`${base}/trial-balance?period=${period}`);
              }
            }}
          />
        </div>
      }
    >
      {rows.length === 0 ? (
        <BackofficeSystemState
          flush
          tone="empty"
          label="Trial balance"
          title="Nothing posted yet"
          description="Accounts show here once entries in this fiscal year post to them."
        />
      ) : (
        <SurfaceTable columns={COLUMNS}>
          {rows.map((row) => (
            <SurfaceTableRow
              key={row.accountId}
              columns={COLUMNS}
              cells={[
                row.code,
                <Link key="account" to={`${base}/accounts/${row.accountId}`}>
                  {row.name}
                </Link>,
                amount(row.debitMinor),
                amount(row.creditMinor),
                balance(row.debitMinor - row.creditMinor),
              ]}
            />
          ))}
          <SurfaceTableRow
            columns={COLUMNS}
            cells={[
              "",
              <strong key="total">Total</strong>,
              <strong key="debits">{amount(debits)}</strong>,
              <strong key="credits">{amount(credits)}</strong>,
              "",
            ]}
          />
        </SurfaceTable>
      )}
    </SurfacePanel>
  );
}
