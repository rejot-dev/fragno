import { Form, Link } from "react-router";

import { FormContainer } from "@/components/backoffice";
import { getAuthMe } from "@/fragno/auth/auth-server";
import {
  BILLING_TRACKER_DEFAULT_PAGE_SIZE,
  billingPeriodSchema,
  type BillingTracker,
} from "@/fragno/billing";
import { decodeBillingTrackerCursor } from "@/fragno/billing/pagination";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/organisation-billing";
import { buildBackofficeLoginPath } from "./auth-navigation";
import { throwOrganisationNotFound } from "./route-errors";

const TOTAL_COST_METER = "ai.cost.total";

const currentUtcPeriod = () => new Date().toISOString().slice(0, 7);

const shiftPeriod = (period: string, months: number) => {
  const [year, month] = period.split("-").map(Number);
  const absoluteMonth = year * 12 + month - 1 + months;
  const shiftedYear = Math.floor(absoluteMonth / 12);
  const shiftedMonth = absoluteMonth - shiftedYear * 12 + 1;
  return `${String(shiftedYear).padStart(4, "0")}-${String(shiftedMonth).padStart(2, "0")}`;
};

const formatPeriod = (period: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${period}-01T00:00:00.000Z`));

const formatInteger = (quantity: string | undefined) =>
  new Intl.NumberFormat("en-US").format(BigInt(quantity ?? "0"));

const formatUsd = (quantity: string | undefined) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(Number(BigInt(quantity ?? "0")) / 1_000_000_000);

const formatTrackerQuantity = (tracker: BillingTracker) =>
  tracker.unit === "nano-usd" ? formatUsd(tracker.quantity) : formatInteger(tracker.quantity);

const formatTimestamp = (value: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(value));

const billingPagePath = (period: string, cursor?: string) => {
  const search = new URLSearchParams({ period });
  if (cursor) {
    search.set("cursor", cursor);
  }
  return `?${search.toString()}`;
};

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  if (!me.organizations.some((entry) => entry.organization.id === params.orgId)) {
    throwOrganisationNotFound(params.orgId);
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
  const requestedCursor = search.get("cursor");
  const cursor = requestedCursor === null ? undefined : requestedCursor.trim();
  const scope = { kind: "org" as const, orgId: params.orgId };

  if (requestedCursor !== null && !cursor) {
    throw new Response("Invalid billing page cursor.", { status: 400 });
  }
  if (cursor) {
    try {
      decodeBillingTrackerCursor({ encodedCursor: cursor, scope, period });
    } catch {
      throw new Response("Invalid billing page cursor.", { status: 400 });
    }
  }

  const billing = context.get(BackofficeWorkerContext).runtime.objects.billing.forOrg(params.orgId);
  const page = await billing.getTrackers({
    scope,
    period,
    pageSize: BILLING_TRACKER_DEFAULT_PAGE_SIZE,
    cursor,
    summaryMeter: TOTAL_COST_METER,
  });

  return { period, cursor: cursor ?? null, ...page };
}

export function meta() {
  return [{ title: "Organisation Billing" }];
}

export default function BackofficeOrganisationBilling({ loaderData }: Route.ComponentProps) {
  const { period, cursor, trackers, nextCursor, hasNextPage, summaryTracker } = loaderData;
  const totalCost = summaryTracker?.quantity;
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
        description="Monthly counters maintained by this organisation's Billing object, ordered by meter."
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

        {cursor || hasNextPage ? (
          <div className="mt-4 flex justify-end gap-2">
            {cursor ? <PageLink to={billingPagePath(period)} label="First page" /> : null}
            {hasNextPage && nextCursor ? (
              <PageLink to={billingPagePath(period, nextCursor)} label="Next page →" />
            ) : null}
          </div>
        ) : null}
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
