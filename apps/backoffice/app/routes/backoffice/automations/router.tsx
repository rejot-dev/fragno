import { Link, useOutletContext, useSearchParams } from "react-router";

import { eq, useLiveQuery } from "@tanstack/react-db";

import type { AutomationRouteDefinition } from "@/fragno/automation/routing";

import { formatTimestamp, formatTimestampInTimeZone } from "./formatting";
import type { AutomationLayoutContext } from "./layout-context";
import { automationScopeTabPath } from "./scope";
import { AutomationNotice } from "./shared";

const buildRouteLink = ({ basePath, routeId }: { basePath: string; routeId: string }) => {
  const params = new URLSearchParams({ route: routeId });
  return `${basePath}?${params.toString()}`;
};

const routeMatcherLabel = (route: AutomationRouteDefinition) => {
  if (route.trigger.kind !== "event") {
    return "";
  }
  return route.trigger.matcher
    ? JSON.stringify(route.trigger.matcher, null, 2)
    : "All events matching source/type.";
};

const routeListTriggerLabel = (route: AutomationRouteDefinition) => {
  if (route.trigger.kind === "event") {
    return `${route.trigger.source}/${route.trigger.eventType}`;
  }
  if (route.trigger.cadence.kind === "once") {
    return `once · ${formatTimestamp(route.trigger.cadence.at)}`;
  }
  return `cron ${route.trigger.cadence.expression} · ${route.trigger.cadence.timeZone}`;
};

const routeWorkflowName = (route: AutomationRouteDefinition) => {
  const action = route.action;
  if (action.kind === "forward_event") {
    return null;
  }
  if (action.kind === "send_workflow_event") {
    return action.workflowName;
  }
  if (action.remoteWorkflowName) {
    return action.remoteWorkflowName;
  }

  const scriptName = action.workflowScriptPath.split("/").pop();
  return scriptName?.replace(/\.workflow\.js$/u, "") || action.workflowName;
};

const routeWorkflowLink = (route: AutomationRouteDefinition) => {
  const workflowName = routeWorkflowName(route);
  if (!workflowName) {
    return null;
  }
  return `/workflows?${new URLSearchParams({ workflow: workflowName }).toString()}`;
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
        ["workflow", routeWorkflowName(route) ?? action.workflowName],
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

const routeSections = (routes: AutomationRouteDefinition[]) => [
  {
    id: "system" as const,
    label: "System",
    routes: routes.filter((route) => route.id.startsWith("system-")),
  },
  {
    id: "workspace" as const,
    label: "Workspace",
    routes: routes.filter((route) => !route.id.startsWith("system-")),
  },
];

const toErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Automation route synchronization failed.";

export default function BackofficeAutomationRouter() {
  const { selectedScope, collections } = useOutletContext<AutomationLayoutContext>();
  const routesQuery = useLiveQuery(
    (query) =>
      query
        .from({ route: collections.routes })
        .leftJoin({ schedule: collections.routeScheduleStates }, ({ route, schedule }) =>
          eq(route.id, schedule.id),
        )
        .orderBy(({ route }) => route.priority, "asc")
        .orderBy(({ route }) => route.id, "asc")
        .select(({ route, schedule }) => ({
          id: route.id,
          name: route.name,
          enabled: route.enabled,
          priority: route.priority,
          trigger: route.trigger,
          action: route.action,
          description: route.description,
          nextOccurrenceAt: schedule?.nextOccurrenceAt,
        })),
    [collections.routeScheduleStates, collections.routes],
  );
  const routes: AutomationRouteDefinition[] = (routesQuery.data ?? []).map((route) => ({
    ...route,
    nextOccurrenceAt: route.nextOccurrenceAt?.toISOString() ?? null,
  }));
  const routeError = routesQuery.isError
    ? toErrorMessage(
        collections.routes.utils.getLastError() ??
          collections.routeScheduleStates.utils.getLastError(),
      )
    : null;
  const [searchParams] = useSearchParams();
  const selectedRouteId = searchParams.get("route")?.trim() ?? "";
  const selectedRoute = routes.find((route) => route.id === selectedRouteId) ?? null;
  const selectedWorkflowLink = selectedRoute ? routeWorkflowLink(selectedRoute) : null;
  const basePath = automationScopeTabPath(selectedScope, "router");
  const isDetailVisible = Boolean(selectedRoute);
  const enabledRoutes = routes.filter((route) => route.enabled).length;
  const sections = routeSections(routes).filter((section) => section.routes.length > 0);

  if (routesQuery.isLoading && routes.length === 0) {
    return (
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        Loading automation routes…
      </div>
    );
  }

  if (routeError && routes.length === 0) {
    return (
      <AutomationNotice tone="error">
        <p className="text-[10px] tracking-[0.22em] uppercase">
          Could not synchronize automation routes
        </p>
        <p className="mt-2 text-sm">{routeError}</p>
      </AutomationNotice>
    );
  }

  if (routes.length === 0) {
    return (
      <div className="w-full max-w-7xl border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        No automation routes are defined for this scope.
      </div>
    );
  }

  return (
    <section className="w-full max-w-7xl space-y-4">
      {routeError ? (
        <AutomationNotice tone="error">
          <p className="text-[10px] tracking-[0.22em] uppercase">
            Could not synchronize all automation routes
          </p>
          <p className="mt-2 text-sm">{routeError}</p>
        </AutomationNotice>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[24rem_minmax(0,1fr)]">
        <div
          className={`${isDetailVisible ? "hidden lg:block" : "block"} border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                Router
              </p>
              <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">Automation routes</h2>
            </div>
            <div className="text-right">
              <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                Enabled
              </p>
              <p className="mt-1 text-sm font-semibold text-[var(--bo-fg)]">
                {enabledRoutes}/{routes.length}
              </p>
            </div>
          </div>

          <div className="mt-4 space-y-5">
            {sections.map((section, sectionIndex) => (
              <div key={section.id} className="space-y-2">
                <div
                  className={
                    sectionIndex > 0 ? "flex items-center gap-3 pt-2" : "flex items-center gap-3"
                  }
                >
                  <div className="h-px flex-1 bg-[var(--bo-border)]" />
                  <span className="text-[9px] font-semibold tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                    {section.label}
                  </span>
                  <div className="h-px flex-1 bg-[var(--bo-border)]" />
                </div>

                <div className="space-y-1">
                  {section.routes.map((route) => {
                    const isSelected = route.id === selectedRouteId;

                    return (
                      <Link
                        key={route.id}
                        to={buildRouteLink({ basePath, routeId: route.id })}
                        preventScrollReset
                        aria-current={isSelected ? "page" : undefined}
                        className={
                          isSelected
                            ? "block border-l-2 border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2.5 text-left"
                            : "block border-l-2 border-transparent px-3 py-2.5 text-left transition-colors hover:border-[color:var(--bo-border-strong)] hover:bg-[var(--bo-panel-2)]"
                        }
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-sm font-medium text-[var(--bo-fg)]">
                            {route.name}
                          </p>
                          <span className="shrink-0 text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                            {route.enabled ? "on" : "off"}
                          </span>
                        </div>
                        <p className="mt-1 truncate font-mono text-[11px] text-[var(--bo-muted-2)]">
                          {routeListTriggerLabel(route)}
                        </p>
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div
          className={`${isDetailVisible ? "block" : "hidden lg:block"} border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
        >
          {selectedRoute ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 lg:hidden">
                  <Link
                    to={basePath}
                    className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                  >
                    Back to list
                  </Link>
                </div>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-2xl font-semibold text-[var(--bo-fg)]">
                      {selectedRoute.name}
                    </h2>
                    <p className="mt-1 font-mono text-[11px] break-all text-[var(--bo-muted-2)]">
                      {selectedRoute.id}
                    </p>
                  </div>
                  <span
                    className={
                      selectedRoute.enabled
                        ? "border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[9px] font-semibold tracking-[0.2em] text-emerald-700 uppercase dark:text-emerald-200"
                        : "border border-[color:var(--bo-border)] px-2 py-1 text-[9px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase"
                    }
                  >
                    {selectedRoute.enabled ? "enabled" : "disabled"}
                  </span>
                </div>
              </div>

              <div className="overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
                <div className="border-b border-[color:var(--bo-border)] px-4 py-3">
                  <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                    Route
                  </p>
                </div>
                <dl className="divide-y divide-[color:var(--bo-border)]">
                  {(selectedRoute.trigger.kind === "event"
                    ? [
                        ["source", selectedRoute.trigger.source],
                        ["event", selectedRoute.trigger.eventType],
                        ["priority", String(selectedRoute.priority)],
                      ]
                    : [["trigger", "schedule"]]
                  ).map(([label, value]) => (
                    <div key={label} className="grid gap-2 px-4 py-3 md:grid-cols-[9rem_1fr]">
                      <dt className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                        {label}
                      </dt>
                      <dd className="font-mono text-xs break-all text-[var(--bo-fg)]">{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>

              <div className="overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
                <div className="border-b border-[color:var(--bo-border)] px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                        Action · {selectedRoute.action.kind}
                      </p>
                      <p className="mt-1 text-sm font-medium text-[var(--bo-fg)]">
                        {routeActionLabel(selectedRoute)}
                      </p>
                    </div>
                    {selectedWorkflowLink ? (
                      <Link
                        to={selectedWorkflowLink}
                        className="inline-flex min-h-10 items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.18em] text-[var(--bo-muted)] uppercase transition-[border-color,color,transform] hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] active:scale-[0.96]"
                      >
                        View workflow
                        <span aria-hidden="true">↗</span>
                      </Link>
                    ) : null}
                  </div>
                </div>
                <dl className="divide-y divide-[color:var(--bo-border)]">
                  {routeActionDetail(selectedRoute).map(([label, value]) => (
                    <div key={label} className="grid gap-2 px-4 py-3 md:grid-cols-[9rem_1fr]">
                      <dt className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                        {label}
                      </dt>
                      <dd className="font-mono text-xs break-all text-[var(--bo-fg)]">{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>

              {selectedRoute.trigger.kind === "event" ? (
                <div className="overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
                  <div className="border-b border-[color:var(--bo-border)] px-4 py-3">
                    <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                      Matcher
                    </p>
                  </div>
                  <pre className="backoffice-scroll max-h-[24rem] overflow-auto px-4 py-4 font-mono text-xs break-words whitespace-pre-wrap text-[var(--bo-fg)]">
                    <code>{routeMatcherLabel(selectedRoute)}</code>
                  </pre>
                </div>
              ) : (
                <div className="overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[color:var(--bo-border)] px-4 py-3">
                    <div>
                      <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                        Schedule
                      </p>
                      <p className="mt-1 text-sm font-medium text-[var(--bo-fg)]">
                        {selectedRoute.trigger.cadence.kind === "once"
                          ? "One-time occurrence"
                          : "Recurring cron schedule"}
                      </p>
                    </div>
                    <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 font-mono text-[9px] font-semibold tracking-[0.16em] text-[var(--bo-muted)] uppercase">
                      {selectedRoute.trigger.cadence.kind}
                    </span>
                  </div>
                  <dl className="divide-y divide-[color:var(--bo-border)]">
                    {selectedRoute.trigger.cadence.kind === "once" ? (
                      <div className="grid gap-2 px-4 py-3 md:grid-cols-[9rem_1fr]">
                        <dt className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                          Runs at
                        </dt>
                        <dd className="font-mono text-xs text-[var(--bo-fg)] tabular-nums">
                          <time dateTime={selectedRoute.trigger.cadence.at}>
                            {formatTimestamp(selectedRoute.trigger.cadence.at)}
                          </time>
                        </dd>
                      </div>
                    ) : (
                      <>
                        <div className="grid gap-2 px-4 py-3 md:grid-cols-[9rem_1fr]">
                          <dt className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                            Expression
                          </dt>
                          <dd className="font-mono text-xs text-[var(--bo-fg)] tabular-nums">
                            {selectedRoute.trigger.cadence.expression}
                          </dd>
                        </div>
                        <div className="grid gap-2 px-4 py-3 md:grid-cols-[9rem_1fr]">
                          <dt className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                            Time zone
                          </dt>
                          <dd className="font-mono text-xs text-[var(--bo-fg)]">
                            {selectedRoute.trigger.cadence.timeZone}
                          </dd>
                        </div>
                      </>
                    )}
                    <div className="grid gap-2 bg-[var(--bo-panel-2)] px-4 py-3 md:grid-cols-[9rem_1fr]">
                      <dt className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                        Next occurrence
                      </dt>
                      <dd className="font-mono text-xs text-[var(--bo-fg)] tabular-nums">
                        {selectedRoute.nextOccurrenceAt ? (
                          <time dateTime={selectedRoute.nextOccurrenceAt}>
                            {formatTimestampInTimeZone(
                              selectedRoute.nextOccurrenceAt,
                              selectedRoute.trigger.cadence.kind === "cron"
                                ? selectedRoute.trigger.cadence.timeZone
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
          ) : (
            <div className="space-y-4">
              <div className="border border-dashed border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-6 text-sm text-[var(--bo-muted)]">
                Select a route to inspect its trigger and action.
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
