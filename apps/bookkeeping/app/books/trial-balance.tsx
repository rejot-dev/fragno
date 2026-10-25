import { PageHeading } from "@fragno-private/design-system/page-heading";
import { Select } from "@fragno-private/design-system/select";
import {
  SurfaceCard,
  SurfaceTable,
  SurfaceTableRow,
  SurfaceTableTotalRow,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { Link, useNavigate, useOutletContext } from "react-router";

import { today } from "../../workers/books/fiscal-years";
import { formatAmount } from "../../workers/books/money";
import type { Route } from "./+types/trial-balance";
import { AccountName, Balance } from "./amounts";
import { formatDate, formatDateRange, indexBooks } from "./books";
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
      <>
        <PageHeading eyebrow={books.name} title="Trial balance" meta={null} actions={null} />
        <BackofficeSystemState
          tone="empty"
          label="Trial balance"
          title="No fiscal years yet"
          description="Open a fiscal year in the books' settings to post and report."
        />
      </>
    );
  }
  const digits = indexBooks(books).minorUnitDigits(books.functionalCurrency);
  // Zero shows as nothing, so the amounts that make up the totals stand out.
  const amount = (minor: bigint) => (minor === 0n ? "" : formatAmount(minor, digits));
  const debits = rows.reduce((sum, row) => sum + row.debitMinor, 0n);
  const credits = rows.reduce((sum, row) => sum + row.creditMinor, 0n);
  const year = books.fiscalYears.find((row) =>
    row.periods.some((period) => period.id === periodId),
  )!;
  const period = year.periods.find((row) => row.id === periodId)!;
  return (
    <>
      <PageHeading
        eyebrow={books.name}
        title="Trial balance"
        meta={`${formatDateRange(year.startDate, period.endDate)} · ${books.functionalCurrency}`}
        actions={
          <div className="w-64">
            <Select
              aria-label="Through period"
              options={books.fiscalYears.flatMap((row) =>
                row.periods.map((option) => ({
                  label: `Through ${formatDate(option.endDate)}`,
                  value: option.id,
                })),
              )}
              value={periodId}
              onValueChange={(next) => {
                if (next !== null) {
                  void navigate(`${base}/trial-balance?period=${next}`);
                }
              }}
            />
          </div>
        }
      />
      <SurfaceCard>
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
                  <Link
                    key="account"
                    to={`${base}/accounts/${row.accountId}`}
                    className="text-[var(--bo-fg)] hover:underline"
                  >
                    <AccountName account={row} />
                  </Link>,
                  amount(row.debitMinor),
                  amount(row.creditMinor),
                  <Balance
                    key="balance"
                    minor={row.debitMinor - row.creditMinor}
                    digits={digits}
                  />,
                ]}
              />
            ))}
            <SurfaceTableTotalRow
              columns={COLUMNS}
              cells={[
                "Total",
                formatAmount(debits, digits),
                formatAmount(credits, digits),
                <Balance key="balance" minor={debits - credits} digits={digits} />,
              ]}
            />
          </SurfaceTable>
        )}
      </SurfaceCard>
    </>
  );
}
