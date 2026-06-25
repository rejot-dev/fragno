import { Link, useOutletContext, useSearchParams } from "react-router";

import { automationScopeTabPath } from "./scope";
import type { AutomationLayoutContext, AutomationRouteItem } from "./shared";
import { AutomationNotice } from "./shared";

const buildRouteLink = ({ basePath, routeId }: { basePath: string; routeId: string }) => {
  const params = new URLSearchParams({ route: routeId });
  return `${basePath}?${params.toString()}`;
};

const routeMatcherLabel = (route: AutomationRouteItem) =>
  route.matcher ? JSON.stringify(route.matcher, null, 2) : "All events matching source/type.";

const routeActionLabel = (route: AutomationRouteItem) =>
  route.action.kind === "start_workflow" ? "Start workflow" : "Send workflow event";

const routeActionDetail = (route: AutomationRouteItem) => {
  const action = route.action;
  if (action.kind === "start_workflow") {
    return [
      ["script", action.workflowScriptPath],
      ["instance", action.instanceIdTemplate],
    ];
  }

  return [
    ["event", action.eventType],
    ["target", action.target.kind === "instance_id" ? "instance id" : "stored instance id"],
    [
      "template",
      action.target.kind === "instance_id" ? action.target.template : action.target.keyTemplate,
    ],
  ];
};

const routeSections = (routes: AutomationRouteItem[]) => [
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

export default function BackofficeAutomationRouter() {
  const { selectedScope, routes, routesError } = useOutletContext<AutomationLayoutContext>();
  const [searchParams] = useSearchParams();
  const selectedRouteId = searchParams.get("route")?.trim() ?? "";
  const selectedRoute = routes.find((route) => route.id === selectedRouteId) ?? null;
  const basePath = automationScopeTabPath(selectedScope, "router");
  const isDetailVisible = Boolean(selectedRoute);
  const enabledRoutes = routes.filter((route) => route.enabled).length;
  const sections = routeSections(routes).filter((section) => section.routes.length > 0);

  if (routesError && routes.length === 0) {
    return (
      <AutomationNotice tone="error">
        <p className="text-[10px] tracking-[0.22em] uppercase">Could not load automation routes</p>
        <p className="mt-2 text-sm">{routesError}</p>
      </AutomationNotice>
    );
  }

  if (routes.length === 0) {
    return (
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        No automation routes are defined for this scope.
      </div>
    );
  }

  return (
    <section className="space-y-4">
      {routesError ? (
        <AutomationNotice tone="error">
          <p className="text-[10px] tracking-[0.22em] uppercase">Could not load all routes</p>
          <p className="mt-2 text-sm">{routesError}</p>
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
                          {route.source}/{route.eventType}
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
                  {[
                    ["source", selectedRoute.source],
                    ["event", selectedRoute.eventType],
                    ["priority", String(selectedRoute.priority)],
                  ].map(([label, value]) => (
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
                  <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                    Action · {selectedRoute.action.kind}
                  </p>
                  <p className="mt-1 text-sm font-medium text-[var(--bo-fg)]">
                    {routeActionLabel(selectedRoute)}
                  </p>
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
            </div>
          ) : (
            <div className="space-y-4">
              <div className="border border-dashed border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-6 text-sm text-[var(--bo-muted)]">
                Select a route to inspect its matcher and action.
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
