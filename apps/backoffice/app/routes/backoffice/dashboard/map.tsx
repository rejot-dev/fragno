import { backofficePageBodyClassName } from "@/components/backoffice/page-body";

import { loadPageSources } from "../pages/load.server";
import type { Route } from "./+types/map";
import { DashboardReplica } from "./dashboard-replica";
import { DashboardTabs } from "./dashboard-tabs";
import { loadOrchestration } from "./orchestration-loader.server";
import { ScopeOrchestration } from "./orchestration-panel";
import { shouldRevalidateOrchestration } from "./path";

const pageClassName = `${backofficePageBodyClassName} flex flex-col gap-4`;

export async function loader({ context, url }: Route.LoaderArgs) {
  return { ...(await loadOrchestration({ context, url })), pageSources: loadPageSources(context) };
}

export const shouldRevalidate = shouldRevalidateOrchestration;

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Map · ${loaderData?.selectedScope.label ?? "scope"}` }];
}

/** How the scope is wired: every source, event, route, and what each route reaches. */
export default function BackofficeDashboardMap({ loaderData }: Route.ComponentProps) {
  return (
    <>
      <DashboardTabs
        selectedScope={loaderData.selectedScope}
        active={{ kind: "map" }}
        pageSources={loaderData.pageSources}
      />
      <div className={pageClassName}>
        <h1 className="sr-only">How {loaderData.selectedScope.label} is wired</h1>
        <DashboardReplica>
          {(replica) => <ScopeOrchestration replica={replica} loaderData={loaderData} />}
        </DashboardReplica>
      </div>
    </>
  );
}
