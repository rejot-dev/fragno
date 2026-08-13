import { Link, useOutletContext, useSearchParams } from "react-router";

import { eq, useLiveQuery } from "@tanstack/react-db";

import type { AutomationRouteDefinition } from "@/fragno/automation/routing";

import { formatTimestamp } from "./formatting";
import type { AutomationLayoutContext } from "./layout-context";
import { AutomationRouteDetail } from "./route-detail";
import { automationScopeTabPath } from "./scope";
import { AutomationNotice } from "./shared";

const buildRouteLink = ({ basePath, routeId }: { basePath: string; routeId: string }) => {
  const params = new URLSearchParams({ route: routeId });
  return `${basePath}?${params.toString()}`;
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
  const basePath = automationScopeTabPath(selectedScope, "router");
  const scriptsPath = automationScopeTabPath(selectedScope, "scripts");
  const eventsCatalogPath = automationScopeTabPath(selectedScope, "events-catalog");
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
    <section className="flex w-full max-w-7xl flex-1 flex-col space-y-4">
      {routeError ? (
        <AutomationNotice tone="error">
          <p className="text-[10px] tracking-[0.22em] uppercase">
            Could not synchronize all automation routes
          </p>
          <p className="mt-2 text-sm">{routeError}</p>
        </AutomationNotice>
      ) : null}

      <div className="grid flex-1 gap-4 lg:grid-cols-[24rem_minmax(0,1fr)]">
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
              <div className="flex flex-wrap items-center gap-2 lg:hidden">
                <Link
                  to={basePath}
                  className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                >
                  Back to list
                </Link>
              </div>
              <AutomationRouteDetail
                route={selectedRoute}
                scriptsPath={scriptsPath}
                eventsCatalogPath={eventsCatalogPath}
              />
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
