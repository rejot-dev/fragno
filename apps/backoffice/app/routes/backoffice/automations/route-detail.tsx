import { Link } from "react-router";

import type { AutomationRouteDefinition } from "@/fragno/automation/routing";

import { formatTimestamp, formatTimestampInTimeZone } from "./formatting";
import { automationRouteWorkflowLink, automationRouteWorkflowName } from "./route-workflow";

const routeMatcherLabel = (route: AutomationRouteDefinition) => {
  if (route.trigger.kind !== "event") {
    return "";
  }
  return route.trigger.matcher
    ? JSON.stringify(route.trigger.matcher, null, 2)
    : "All events matching source/type.";
};

const routeActionLabel = (route: AutomationRouteDefinition) => {
  switch (route.action.kind) {
    case "start_workflow":
      return "Start workflow";
    case "send_workflow_event":
      return "Send workflow event";
    case "forward_event":
      return "Forward event";
  }

  throw new Error("Unsupported automation route action kind.");
};

const routeActionDetail = (route: AutomationRouteDefinition) => {
  const action = route.action;
  switch (action.kind) {
    case "start_workflow":
      return [
        ["workflow", automationRouteWorkflowName(route) ?? action.workflowName],
        ["script", action.workflowScriptPath],
        ["instance", action.instanceIdTemplate],
      ];

    case "send_workflow_event":
      return [
        ["workflow", action.workflowName],
        ["event", action.eventType],
        ["target", action.target.kind === "instance_id" ? "instance id" : "stored instance id"],
        [
          "template",
          action.target.kind === "instance_id" ? action.target.template : action.target.keyTemplate,
        ],
      ];

    case "forward_event":
      return [["target", JSON.stringify(action.targetScope)]];
  }

  throw new Error("Unsupported automation route action kind.");
};

function DetailRows({ rows, compact }: { rows: string[][]; compact: boolean }) {
  return (
    <dl className="divide-y divide-[color:var(--bo-border)]">
      {rows.map(([label, value]) => (
        <div
          key={label}
          className={`grid gap-1.5 px-3 py-2.5 ${compact ? "grid-cols-[6rem_minmax(0,1fr)]" : "md:grid-cols-[9rem_1fr] md:px-4 md:py-3"}`}
        >
          <dt className="text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
            {label}
          </dt>
          <dd className="font-mono text-[11px] break-all text-[var(--bo-fg)]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AutomationRouteDetail({
  route,
  compact = false,
}: {
  route: AutomationRouteDefinition;
  compact?: boolean;
}) {
  const workflowLink = automationRouteWorkflowLink(route);

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
                  ["source", route.trigger.source],
                  ["event", route.trigger.eventType],
                  ["priority", String(route.priority)],
                ]
              : [
                  ["trigger", "schedule"],
                  ["priority", String(route.priority)],
                ]
          }
        />
      </div>

      <div className="overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[color:var(--bo-border)] px-3 py-2.5">
          <div>
            <p className="text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
              Action · {route.action.kind}
            </p>
            <p className="mt-1 text-xs font-medium text-[var(--bo-fg)]">
              {routeActionLabel(route)}
            </p>
          </div>
          {workflowLink ? (
            <Link
              to={workflowLink}
              className="inline-flex min-h-10 items-center gap-1.5 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2.5 py-1.5 text-[8px] font-semibold tracking-[0.15em] text-[var(--bo-muted)] uppercase transition-[border-color,color,transform] hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] active:scale-[0.96]"
            >
              Open workflow <span aria-hidden="true">↗</span>
            </Link>
          ) : null}
        </div>
        <DetailRows compact={compact} rows={routeActionDetail(route)} />
      </div>

      {route.trigger.kind === "event" ? (
        <div className="overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
          <div className="border-b border-[color:var(--bo-border)] px-3 py-2.5">
            <p className="text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
              Matcher
            </p>
          </div>
          <pre className="backoffice-scroll max-h-64 overflow-auto px-3 py-3 font-mono text-[11px] leading-5 break-words whitespace-pre-wrap text-[var(--bo-fg)]">
            <code>{routeMatcherLabel(route)}</code>
          </pre>
        </div>
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
