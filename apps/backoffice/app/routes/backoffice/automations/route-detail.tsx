import { Link } from "react-router";

import type { AutomationRouteDefinition } from "@/fragno/automation/routing";

import { formatTimestamp, formatTimestampInTimeZone } from "./formatting";
import { automationRouteActionLabel } from "./route-action";
import { AutomationEventMatcherDetail, AutomationRouteTargetDetail } from "./route-configuration";
import { automationEventCatalogLink, automationRouteScriptLink } from "./route-links";
import { automationRouteWorkflowName } from "./route-workflow";

type DetailRow = { label: string; value: string; to?: string };

const routeActionDetail = (
  route: AutomationRouteDefinition,
  scriptLink: string | null,
): DetailRow[] => {
  const action = route.action;
  switch (action.kind) {
    case "start_workflow":
      return [
        {
          label: "workflow",
          value: automationRouteWorkflowName(route) ?? "Unknown saved workflow",
        },
        { label: "script", value: action.workflowScriptPath, to: scriptLink ?? undefined },
        { label: "instance", value: action.instanceIdTemplate },
      ];

    case "send_workflow_event":
      return [
        { label: "workflow", value: action.workflowName },
        { label: "event", value: action.eventType },
      ];

    case "forward_event":
      return action.idTemplate ? [{ label: "event id", value: action.idTemplate }] : [];
  }

  throw new Error("Unsupported automation route action kind.");
};

function DetailRows({ rows, compact }: { rows: DetailRow[]; compact: boolean }) {
  return (
    <dl className="divide-y divide-[color:var(--bo-border)]">
      {rows.map((row) => (
        <div
          key={row.label}
          className={`grid gap-1.5 px-3 py-2.5 ${compact ? "grid-cols-[6rem_minmax(0,1fr)]" : "md:grid-cols-[9rem_1fr] md:px-4 md:py-3"}`}
        >
          <dt className="text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
            {row.label}
          </dt>
          <dd className="min-w-0 font-mono text-[11px] break-all text-[var(--bo-fg)]">
            {row.to ? (
              <Link
                to={row.to}
                className="inline-flex min-h-10 items-center text-sky-700 transition-colors hover:text-sky-900 hover:underline dark:text-sky-300 dark:hover:text-sky-100"
              >
                {row.value}
              </Link>
            ) : (
              row.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function AutomationRouteDetail({
  route,
  scriptsPath,
  eventsCatalogPath,
  compact = false,
}: {
  route: AutomationRouteDefinition;
  scriptsPath: string;
  eventsCatalogPath: string;
  compact?: boolean;
}) {
  const scriptLink = automationRouteScriptLink(route, scriptsPath);

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2
              className={`${compact ? "text-lg" : "text-2xl"} font-semibold text-balance text-[var(--bo-fg)]`}
            >
              {route.name}
            </h2>
            <p className="mt-1 font-mono text-[10px] break-all text-[var(--bo-muted-2)]">
              {route.id}
            </p>
          </div>
          <span
            className={
              route.enabled
                ? "border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[8px] font-semibold tracking-[0.18em] text-emerald-700 uppercase dark:text-emerald-200"
                : "border border-[color:var(--bo-border)] px-2 py-1 text-[8px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase"
            }
          >
            {route.enabled ? "enabled" : "disabled"}
          </span>
        </div>
        {route.description ? (
          <p className="text-xs leading-5 text-[var(--bo-muted)]">{route.description}</p>
        ) : null}
      </div>

      <div className="overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
        <div className="border-b border-[color:var(--bo-border)] px-3 py-2.5">
          <p className="text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">Route</p>
        </div>
        <DetailRows
          compact={compact}
          rows={
            route.trigger.kind === "event"
              ? [
                  { label: "source", value: route.trigger.source },
                  {
                    label: "event",
                    value: route.trigger.eventType,
                    to: automationEventCatalogLink(eventsCatalogPath, route.trigger.eventType),
                  },
                  { label: "priority", value: String(route.priority) },
                ]
              : [
                  { label: "trigger", value: "schedule" },
                  { label: "priority", value: String(route.priority) },
                ]
          }
        />
      </div>

      <div className="overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
        <div className="border-b border-[color:var(--bo-border)] px-3 py-2.5">
          <p className="text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
            Action · {route.action.kind}
          </p>
          <p className="mt-1 text-xs font-medium text-[var(--bo-fg)]">
            {automationRouteActionLabel(route)}
          </p>
        </div>
        <DetailRows compact={compact} rows={routeActionDetail(route, scriptLink)} />
      </div>

      {route.action.kind === "send_workflow_event" ? (
        <AutomationRouteTargetDetail target={route.action.target} />
      ) : null}
      {route.action.kind === "forward_event" ? (
        <AutomationRouteTargetDetail target={route.action.targetScope} />
      ) : null}

      {route.trigger.kind === "event" ? (
        <AutomationEventMatcherDetail matcher={route.trigger.matcher} />
      ) : (
        <div className="overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[color:var(--bo-border)] px-3 py-2.5">
            <div>
              <p className="text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                Schedule
              </p>
              <p className="mt-1 text-xs font-medium text-[var(--bo-fg)]">
                {route.trigger.cadence.kind === "once"
                  ? "One-time occurrence"
                  : "Recurring cron schedule"}
              </p>
            </div>
            <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 font-mono text-[8px] font-semibold tracking-[0.14em] text-[var(--bo-muted)] uppercase">
              {route.trigger.cadence.kind}
            </span>
          </div>
          <dl className="divide-y divide-[color:var(--bo-border)]">
            {route.trigger.cadence.kind === "once" ? (
              <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-1.5 px-3 py-2.5">
                <dt className="text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                  Runs at
                </dt>
                <dd className="font-mono text-[11px] text-[var(--bo-fg)] tabular-nums">
                  <time dateTime={route.trigger.cadence.at}>
                    {formatTimestamp(route.trigger.cadence.at)}
                  </time>
                </dd>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-1.5 px-3 py-2.5">
                  <dt className="text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                    Expression
                  </dt>
                  <dd className="font-mono text-[11px] text-[var(--bo-fg)] tabular-nums">
                    {route.trigger.cadence.expression}
                  </dd>
                </div>
                <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-1.5 px-3 py-2.5">
                  <dt className="text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                    Time zone
                  </dt>
                  <dd className="font-mono text-[11px] text-[var(--bo-fg)]">
                    {route.trigger.cadence.timeZone}
                  </dd>
                </div>
              </>
            )}
            <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-1.5 bg-[var(--bo-panel-2)] px-3 py-2.5">
              <dt className="text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                Next
              </dt>
              <dd className="font-mono text-[11px] text-[var(--bo-fg)] tabular-nums">
                {route.nextOccurrenceAt ? (
                  <time dateTime={route.nextOccurrenceAt}>
                    {formatTimestampInTimeZone(
                      route.nextOccurrenceAt,
                      route.trigger.cadence.kind === "cron"
                        ? route.trigger.cadence.timeZone
                        : "UTC",
                    )}
                  </time>
                ) : (
                  <span className="text-[var(--bo-muted)]">None queued</span>
                )}
              </dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}
