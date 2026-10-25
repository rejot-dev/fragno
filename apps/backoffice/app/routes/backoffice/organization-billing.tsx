import { Button, ButtonLink } from "@fragno-private/design-system/button";
import { Input } from "@fragno-private/design-system/input";
import {
  SurfaceFacts,
  SurfacePanel,
  SurfaceTable,
  SurfaceTableRow,
  type SurfaceTableColumn,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { BackofficeTabHeader } from "@fragno-private/design-system/tab-header";
import { Form, useParams } from "react-router";

import { backofficePageBodyClassName } from "@/components/backoffice/page-body";
import { billingPeriodSchema, type BillingStatementTracker } from "@/fragno/billing";
import { getBackofficeShellRequest } from "@/layouts/backoffice-shell-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/organization-billing";
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

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { me } = getBackofficeShellRequest(context);

  const organization = me.organizations.find(
    (entry) => entry.organization.slug === params.orgSlug,
  )?.organization;
  if (params.orgSlug && !organization) {
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
    .runtime.objects.billing.for(
      organization ? { kind: "org", orgId: organization.id } : { kind: "user", userId: me.user.id },
    ).commands;
  const statement = await billing.getStatement({ period });

  return { period, trackers: statement.trackers, ownerName: organization?.name ?? "Personal" };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.ownerName ?? "Personal"} usage` }];
}

export default function BackofficeOrganizationBilling({ loaderData }: Route.ComponentProps) {
  const { orgSlug } = useParams();
  const usage = <BillingUsage {...loaderData} />;
  // Organization billing sits under the organization's tabs; personal usage is a page of its own.
  if (orgSlug !== undefined) {
    return usage;
  }
  return (
    <div className="flex flex-1 flex-col">
      <h1 className="sr-only">Personal usage</h1>
      <BackofficeTabHeader
        items={[{ id: "usage", label: "Usage", to: "/backoffice/usage", active: true }]}
        ariaLabel="Usage"
        trailing={null}
        options={null}
      />
      <div className={`${backofficePageBodyClassName} flex flex-col gap-4`}>{usage}</div>
    </div>
  );
}

const LEDGER_COLUMNS: readonly SurfaceTableColumn[] = [
  { label: "Meter", align: "start" },
  { label: "Quantity", align: "end" },
  { label: "Events", align: "end" },
  { label: "First seen", align: "start" },
  { label: "Last seen", align: "start" },
];

function BillingUsage({ period, trackers, ownerName }: Route.ComponentProps["loaderData"]) {
  const totalCost = trackers.find((tracker) => tracker.meter === TOTAL_COST_METER)?.quantity;
  const previousPeriod = shiftPeriod(period, -1);
  const nextPeriod = shiftPeriod(period, 1);
  const currentPeriod = currentUtcPeriod();

  return (
    <>
      <SurfacePanel
        caption={`${ownerName} usage · ${formatPeriod(period)}`}
        actions={
          <>
            <ButtonLink variant="ghost" to={billingPagePath(previousPeriod)}>
              ← Previous
            </ButtonLink>
            <Form method="get" className="flex gap-2">
              <Input
                key={period}
                type="month"
                name="period"
                aria-label="Billing month"
                defaultValue={period}
                className="text-xs"
              />
              <Button variant="secondary" type="submit">
                View
              </Button>
            </Form>
            {nextPeriod <= currentPeriod ? (
              <ButtonLink variant="ghost" to={billingPagePath(nextPeriod)}>
                Next →
              </ButtonLink>
            ) : null}
          </>
        }
      >
        <SurfaceFacts
          items={[
            {
              key: "cost",
              label: "Recorded model cost",
              value: (
                <>
                  <span className="text-2xl tracking-[-0.02em] tabular-nums">
                    {formatUsd(totalCost)}
                  </span>
                  <span className="block text-xs font-normal text-[var(--bo-muted)]">
                    Recorded by UTC month. Not an invoice.
                  </span>
                </>
              ),
            },
            {
              key: "meters",
              label: "Meters",
              value: <span className="text-2xl tabular-nums">{trackers.length}</span>,
            },
          ]}
        />
      </SurfacePanel>

      <SurfacePanel caption="Usage ledger" actions={null}>
        {trackers.length === 0 ? (
          <BackofficeSystemState
            tone="empty"
            title={`No measurements were recorded for ${formatPeriod(period)}.`}
            description="Model calls and other metered work appear here as they are recorded."
            flush
          />
        ) : (
          <SurfaceTable columns={LEDGER_COLUMNS}>
            {trackers.map((tracker) => (
              <SurfaceTableRow
                key={tracker.meter}
                columns={LEDGER_COLUMNS}
                cells={[
                  <span key="meter" className="block">
                    <span className="block font-mono text-xs font-semibold text-[var(--bo-fg)]">
                      {tracker.meter}
                    </span>
                    <span className="block text-[10px] tracking-[0.16em] text-[var(--bo-muted-2)] uppercase">
                      {tracker.unit}
                    </span>
                  </span>,
                  <span key="quantity" className="font-semibold text-[var(--bo-fg)]">
                    {formatTrackerQuantity(tracker)}
                  </span>,
                  formatInteger(tracker.eventCount),
                  <span key="first" className="text-xs whitespace-nowrap">
                    {formatTimestamp(tracker.firstOccurredAt)}
                  </span>,
                  <span key="last" className="text-xs whitespace-nowrap">
                    {formatTimestamp(tracker.lastOccurredAt)}
                  </span>,
                ]}
              />
            ))}
          </SurfaceTable>
        )}
      </SurfacePanel>
    </>
  );
}
