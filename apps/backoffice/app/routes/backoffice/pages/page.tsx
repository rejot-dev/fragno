import type { PageDefinition, PageLoad } from "@fragno-private/backoffice-ui/pages/definition";
import { ClientOnly } from "@fragno-private/design-system/client-only";
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

import type { Route } from "./+types/page";
import { loadPageRoute } from "./load.server";

// A missing page is data, not a thrown response, so previews that fetch this loader can show it.
export async function loader({ request, context, params }: Route.LoaderArgs) {
  const name = params["*"];
  const result = await loadPageRoute({ request, context, name });
  return data({ name, result }, { status: result.kind === "missing" ? 404 : 200 });
}

/** A built page names itself; until it builds, its file name stands in. */
function pageTitle(name: string, result: PageLoad): string {
  return result.kind === "ready" ? result.definition.title : (name.split("/").at(-1) ?? name);
}

export function meta({ loaderData }: Route.MetaArgs) {
  const title = loaderData ? pageTitle(loaderData.name, loaderData.result) : "Page";
  return [{ title: `${title} · Pages` }];
}

export default function PageRoute({ loaderData }: Route.ComponentProps) {
  const { name, result } = loaderData;
  const loading = <BackofficeSystemState tone="loading" title="Synchronizing automation data." />;

  return (
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
            <PageClient definition={result.definition} />
          </Suspense>
        </ClientOnly>
      )}
    </div>
  );
}

function PageClient({ definition }: { definition: PageDefinition }) {
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
    />
  );
}
