import { underlineTabClassName } from "@fragno-private/design-system/navigation/underline-tab-class-name";
import { Link } from "react-router";

import { backofficeRouteScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { backofficePageBodyClassName } from "@/components/backoffice/page-body";

import { loadPageSources } from "../pages/load.server";
import type { Route } from "./+types/map";
import { DashboardReplica } from "./dashboard-replica";
import { DashboardTabs } from "./dashboard-tabs";
import { loadOrchestration } from "./orchestration-loader.server";
import { ScopeOrchestration } from "./orchestration-panel";
import { OrganizationUniverse } from "./orchestration-universe-panel";
import { dashboardMapViewPath, shouldRevalidateOrchestration, type DashboardMapView } from "./path";

const pageClassName = `${backofficePageBodyClassName} flex flex-col gap-4`;

const MAP_VIEWS: Record<DashboardMapView, string> = { graph: "Graph", universe: "Universe" };

export async function loader({ request, context, url }: Route.LoaderArgs) {
  return {
    ...(await loadOrchestration({ request, context, url })),
    pageSources: loadPageSources(context),
  };
}

export const shouldRevalidate = shouldRevalidateOrchestration;

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Map · ${loaderData?.selectedScope.label ?? "scope"}` }];
}

/**
 * How the scope is wired: every source, event, route, and what each route reaches. An
 * organization's Map can also show its universe: the organization among its projects and members.
 */
export default function BackofficeDashboardMap({ loaderData }: Route.ComponentProps) {
  const { selectedScope, universe } = loaderData;
  const view: DashboardMapView = universe ? "universe" : "graph";
  return (
    <>
      <DashboardTabs
        selectedScope={selectedScope}
        active={{ kind: "map" }}
        pageSources={loaderData.pageSources}
      />
      <div className={pageClassName}>
        <h1 className="sr-only">How {selectedScope.label} is wired</h1>
        {selectedScope.kind === "org" ? (
          <nav
            aria-label="Map view"
            className="flex items-stretch gap-1 shadow-[inset_0_-1px_0_var(--bo-border)]"
          >
            {Object.entries(MAP_VIEWS).map(([id, label]) => (
              <Link
                key={id}
                to={dashboardMapViewPath(
                  backofficeRouteScopeFromResolvedScope(selectedScope),
                  id as DashboardMapView,
                )}
                preventScrollReset
                aria-current={id === view ? "page" : undefined}
                className={underlineTabClassName(id === view ? "selected" : "idle")}
              >
                {label}
              </Link>
            ))}
          </nav>
        ) : null}
        <DashboardReplica>
          {(replica) =>
            universe ? (
              <OrganizationUniverse
                replica={replica}
                selectedScope={selectedScope}
                scopes={universe}
                runtimeToolCatalog={loaderData.runtimeToolCatalog}
              />
            ) : (
              <ScopeOrchestration replica={replica} loaderData={loaderData} />
            )
          }
        </DashboardReplica>
      </div>
    </>
  );
}
