import { Form, Link } from "react-router";

import { FormContainer } from "@/components/backoffice";
import { findBackofficeMe } from "@/fragno/auth/auth-server";
import { billingPeriodSchema, type BillingStatementTracker } from "@/fragno/billing";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/organization-billing";
import { buildBackofficeLoginPath } from "./auth-navigation";
import { throwBackofficeOrganizationNotFound } from "./route-errors";

const TOTAL_COST_METER = "ai.cost.total";

const BILLING_PERIOD_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const BILLING_INTEGER_FORMATTER = new Intl.NumberFormat("en-US");
const BILLING_USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});
const BILLING_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

const currentUtcPeriod = () => new Date().toISOString().slice(0, 7);

const shiftPeriod = (period: string, months: number) => {
  const [year, month] = period.split("-").map(Number);
  const absoluteMonth = year * 12 + month - 1 + months;
  const shiftedYear = Math.floor(absoluteMonth / 12);
  const shiftedMonth = absoluteMonth - shiftedYear * 12 + 1;
  return `${String(shiftedYear).padStart(4, "0")}-${String(shiftedMonth).padStart(2, "0")}`;
};

const formatPeriod = (period: string) =>
  BILLING_PERIOD_FORMATTER.format(new Date(`${period}-01T00:00:00.000Z`));

const formatInteger = (quantity: string | undefined) =>
  BILLING_INTEGER_FORMATTER.format(BigInt(quantity ?? "0"));

const formatUsd = (quantity: string | undefined) =>
  BILLING_USD_FORMATTER.format(Number(BigInt(quantity ?? "0")) / 1_000_000_000);

const formatTrackerQuantity = (tracker: BillingStatementTracker) =>
  tracker.unit === "nano-usd" ? formatUsd(tracker.quantity) : formatInteger(tracker.quantity);

const formatTimestamp = (value: string) => BILLING_TIMESTAMP_FORMATTER.format(new Date(value));

const billingPagePath = (period: string) => `?${new URLSearchParams({ period }).toString()}`;

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  if (!params.orgSlug) {
    throw new Response("Not Found", { status: 404 });
  }

  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const organization = me.organizations.find(
    (entry) => entry.organization.slug === params.orgSlug,
  )?.organization;
  if (!organization) {
    throwBackofficeOrganizationNotFound(params.orgSlug);
  }

  const search = new URL(request.url).searchParams;
  const requestedPeriod = search.get("period");
  const periodResult =
    requestedPeriod === null
      ? { success: true as const, data: currentUtcPeriod() }
      : billingPeriodSchema.safeParse(requestedPeriod.trim());
  if (!periodResult.success) {
    throw new Response("Invalid billing period.", { status: 400 });
  }
  const period = periodResult.data;
  const billing = context
    .get(BackofficeWorkerContext)
    .runtime.objects.billing.forOrg(organization.id).commands;
  const statement = await billing.getStatement({ period });

  return { period, trackers: statement.trackers };
}

export function meta() {
  return [{ title: "Organization Billing" }];
}

export default function BackofficeOrganizationBilling({ loaderData }: Route.ComponentProps) {
  const { period, trackers } = loaderData;
  const totalCost = trackers.find((tracker) => tracker.meter === TOTAL_COST_METER)?.quantity;
  const previousPeriod = shiftPeriod(period, -1);
  const nextPeriod = shiftPeriod(period, 1);
  const currentPeriod = currentUtcPeriod();

  return (
    <div className="space-y-4">
      <FormContainer
        eyebrow="Statement period"
        title={formatPeriod(period)}
        description="Usage is assigned to the UTC month in which each model operation completed."
        actions={
          <Form method="get" className="flex gap-2">
            <input
              key={period}
              type="month"
              name="period"
              defaultValue={period}
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 font-mono text-xs text-[var(--bo-fg)] focus:border-[color:var(--bo-accent)] focus:outline-none"
            />
            <button
              type="submit"
              className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.18em] text-[var(--bo-accent-fg)] uppercase"
            >
              View
            </button>
          </Form>
        }
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[10px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
              Estimated total
            </p>
            <p className="mt-2 font-mono text-4xl font-semibold tracking-[-0.04em] text-[var(--bo-fg)]">
              {formatUsd(totalCost)}
            </p>
          </div>

          <div className="flex gap-2">
            <PeriodLink period={previousPeriod} label="← Previous" />
            {nextPeriod <= currentPeriod ? <PeriodLink period={nextPeriod} label="Next →" /> : null}
          </div>
        </div>
      </FormContainer>

      <FormContainer
        eyebrow="Recorded measurements"
        title="Statement ledger"
        description="Monthly counters maintained by this organization's Billing object, ordered by meter."
      >
        {trackers.length === 0 ? (
          <div className="border border-dashed border-[color:var(--bo-border-strong)] bg-[var(--bo-panel-2)] px-5 py-8 text-center">
            <p className="text-sm text-[var(--bo-muted)]">
              No measurements were recorded for {formatPeriod(period)}.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto border border-[color:var(--bo-border)]">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead className="bg-[var(--bo-panel-2)] text-[10px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                <tr>
                  <th className="border-b border-[color:var(--bo-border)] px-3 py-2 font-semibold">
                    Meter
                  </th>
                  <th className="border-b border-[color:var(--bo-border)] px-3 py-2 text-right font-semibold">
                    Quantity
                  </th>
                  <th className="border-b border-[color:var(--bo-border)] px-3 py-2 text-right font-semibold">
                    Events
                  </th>
                  <th className="border-b border-[color:var(--bo-border)] px-3 py-2 font-semibold">
                    First seen
                  </th>
                  <th className="border-b border-[color:var(--bo-border)] px-3 py-2 font-semibold">
                    Last seen
                  </th>
                </tr>
              </thead>
              <tbody>
                {trackers.map((tracker) => (
                  <tr
                    key={tracker.meter}
                    className="border-b border-[color:var(--bo-border)] last:border-b-0"
                  >
                    <td className="px-3 py-3">
                      <p className="font-mono text-xs font-semibold text-[var(--bo-fg)]">
                        {tracker.meter}
                      </p>
                      <p className="mt-1 text-[10px] tracking-[0.16em] text-[var(--bo-muted-2)] uppercase">
                        {tracker.unit}
                      </p>
                    </td>
                    <td className="px-3 py-3 text-right font-mono font-semibold text-[var(--bo-fg)]">
                      {formatTrackerQuantity(tracker)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-[var(--bo-muted)]">
                      {formatInteger(tracker.eventCount)}
                    </td>
                    <td className="px-3 py-3 text-xs text-[var(--bo-muted)]">
                      {formatTimestamp(tracker.firstOccurredAt)}
                    </td>
                    <td className="px-3 py-3 text-xs text-[var(--bo-muted)]">
                      {formatTimestamp(tracker.lastOccurredAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </FormContainer>
    </div>
  );
}

function PeriodLink({ period, label }: { period: string; label: string }) {
  return <PageLink to={billingPagePath(period)} label={label} />;
}

function PageLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.18em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
    >
      {label}
    </Link>
  );
}
