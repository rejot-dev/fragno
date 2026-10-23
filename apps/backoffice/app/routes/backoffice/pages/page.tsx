import type { PageDefinition, PageLoad } from "@fragno-private/backoffice-ui/pages/definition";
import { ClientOnly } from "@fragno-private/design-system/client-only";
import { PaneSpinner } from "@fragno-private/design-system/pane-message";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { Suspense, use } from "react";
import { data } from "react-router";

import { BackofficePageView } from "@/artifacts/pages/view";
import { useCurrentBackofficeContext } from "@/components/backoffice/current-context";
import { backofficePageBodyClassName } from "@/components/backoffice/page-body";
import {
  describeAutomationCollectionSource,
  getAutomationBrowserDatabase,
} from "@/fragno/automation/tanstack/browser-database";

import { DashboardTabs } from "../dashboard/dashboard-tabs";
import { loadOrchestration } from "../dashboard/orchestration-loader.server";
import type { OrchestrationLoaderData } from "../dashboard/orchestration-panel";
import { shouldRevalidateOrchestration } from "../dashboard/path";
import type { Route } from "./+types/page";
import { loadPageRoute, loadPageSources } from "./load.server";

// A missing page is data, not a thrown response, so previews that fetch this loader can show it.
export async function loader({ request, context, params, url }: Route.LoaderArgs) {
  const name = params["*"];
  const [result, orchestration] = await Promise.all([
    loadPageRoute({ request, context, name }),
    loadOrchestration({ context, url }),
  ]);
  // Started once the route has loaded: when it throws, such as for a scope that does not
  // resolve, nothing would await the listing.
  return data(
    { name, result, orchestration, pageSources: loadPageSources(context) },
    { status: result.kind === "missing" ? 404 : 200 },
  );
}

export const shouldRevalidate = shouldRevalidateOrchestration;

/** A built page names itself; until it builds, its file name stands in. */
function pageTitle(name: string, result: PageLoad): string {
  return result.kind === "ready" ? result.definition.title : (name.split("/").at(-1) ?? name);
}

export function meta({ loaderData }: Route.MetaArgs) {
  const title = loaderData ? pageTitle(loaderData.name, loaderData.result) : "Page";
  return [{ title: `${title} · Pages` }];
}

export default function PageRoute({ loaderData }: Route.ComponentProps) {
  const { name, result, orchestration, pageSources } = loaderData;
  const loading = <PaneSpinner label="Synchronizing automation data" />;

  return (
    <>
      <DashboardTabs
        selectedScope={orchestration.selectedScope}
        active={{ kind: "page", name }}
        pageSources={pageSources}
      />
      <div className={`${backofficePageBodyClassName} flex flex-col gap-4`}>
        <h1 className="text-lg font-semibold text-[var(--bo-fg)]">{pageTitle(name, result)}</h1>
        {result.kind === "missing" ? (
          <BackofficeSystemState tone="empty" label="Not found" title="This page does not exist." />
        ) : result.kind === "failed" ? (
          <BackofficeSystemState
            tone="error"
            label="Invalid page"
            title="This page could not be built."
            description={result.message}
          />
        ) : (
          <ClientOnly fallback={loading}>
            <Suspense fallback={loading}>
              <PageClient definition={result.definition} orchestration={orchestration} />
            </Suspense>
          </ClientOnly>
        )}
      </div>
    </>
  );
}

function PageClient({
  definition,
  orchestration,
}: {
  definition: PageDefinition;
  orchestration: OrchestrationLoaderData;
}) {
  const { automationCollectionSource } = useCurrentBackofficeContext();
  if (automationCollectionSource.status === "unavailable") {
    return (
      <BackofficeSystemState
        tone="error"
        label="Unavailable"
        title="Automation data could not be synchronized."
        description={automationCollectionSource.message}
      />
    );
  }
  const source = automationCollectionSource.source;
  return (
    <BackofficePageView
      key={describeAutomationCollectionSource(source).resourceKey}
      definition={definition}
      collections={use(getAutomationBrowserDatabase(source)).collections}
      orchestration={orchestration}
    />
  );
}
