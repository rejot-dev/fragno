import type { LofiSqliteClient, LofiSqliteGuardedResult } from "@fragno-dev/lofi/sqlite";
import type { BackofficeUiLinkTarget } from "@fragno-private/backoffice-ui/link";
import type { PageDefinition } from "@fragno-private/backoffice-ui/pages/definition";
import { pageQueryParams } from "@fragno-private/backoffice-ui/pages/rows";
import { PageView, type PageQueryState } from "@fragno-private/backoffice-ui/pages/view";
import {
  useMinuteClock,
  type BackofficeUiHostWidgets,
} from "@fragno-private/backoffice-ui/render-context";
import { useMemo, useSyncExternalStore } from "react";

import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { useCurrentBackofficeContext } from "@/components/backoffice/current-context";
import { AUTOMATION_PAGE_VIEWS } from "@/fragno/automation/lofi/replica-schemas";
import { piAgentsPath } from "@/routes/backoffice/agents/path";
import {
  ScopeOrchestration,
  type OrchestrationLoaderData,
} from "@/routes/backoffice/dashboard/orchestration-panel";
import { dashboardRunPath, dashboardSelectionPath } from "@/routes/backoffice/dashboard/path";
import { WorkflowRunResponse } from "@/routes/backoffice/dashboard/workflow-run-response";
import {
  integrationConnectionPath,
  integrationsScopeBasePath,
} from "@/routes/backoffice/integrations/connection-paths";

/**
 * Renders a page over the current scope's Automations replica, with links into that scope, and
 * draws its host widgets: the orchestration graph from the route's loader data, and the forms runs
 * ask.
 */
export function BackofficePageView({
  definition,
  replica,
  orchestration,
}: {
  definition: PageDefinition;
  replica: LofiSqliteClient;
  orchestration: OrchestrationLoaderData;
}) {
  const { resolvedScope } = useCurrentBackofficeContext();
  const now = useMinuteClock();
  const results = usePageResults(replica, definition, now);
  const links = useMemo(() => pageLinks(resolvedScope), [resolvedScope]);
  const widgets = useMemo(
    (): BackofficeUiHostWidgets => ({
      orchestration: () => <ScopeOrchestration replica={replica} loaderData={orchestration} />,
      workflowResponse: (run) => (
        <WorkflowRunResponse
          readSource={{ kind: "replica", replica }}
          resolvedScope={resolvedScope}
          run={run}
        />
      ),
    }),
    [replica, orchestration, resolvedScope],
  );
  return (
    <PageView definition={definition} results={results} now={now} links={links} widgets={widgets} />
  );
}

const LOADING: PageQueryState = { status: "loading" };

/**
 * Each of the page's queries as a guarded SQL view of the replica, which its worker runs again
 * after every batch that wrote a relation the query reads. A query whose times move with `now`
 * opens a new view every minute; the page shows its last rows until the new ones arrive.
 */
function usePageResults(
  replica: LofiSqliteClient,
  definition: PageDefinition,
  now: number,
): Readonly<Record<string, PageQueryState>> {
  const queries = useMemo(
    () =>
      Object.entries(definition.queries).map(([name, query]) => ({
        name,
        sql: query.sql,
        params: pageQueryParams(query, now),
      })),
    [definition, now],
  );
  // Views open only when what a query asks for changed, not on every tick of the clock.
  const key = JSON.stringify(queries);
  const store = useMemo(() => {
    const views = (JSON.parse(key) as typeof queries).map(({ name, sql, params }) => ({
      name,
      view: replica.view<LofiSqliteGuardedResult>(AUTOMATION_PAGE_VIEWS, { sql, params }),
    }));
    let snapshot: Record<string, PageQueryState> = {};
    const read = () => {
      snapshot = Object.fromEntries(
        views.map(({ name, view }): [string, PageQueryState] => {
          const result = view.get();
          if (result.status === "loading") {
            return [name, LOADING];
          }
          if (result.status === "error") {
            return [name, { status: "error", message: result.message }];
          }
          const data = result.data;
          return [
            name,
            data.status === "error"
              ? { status: "error", message: data.message }
              : { status: "ready", result: data },
          ];
        }),
      );
    };
    read();
    return {
      subscribe: (onChange: () => void) => {
        const unsubscribes = views.map(({ view }) =>
          view.listen(() => {
            read();
            onChange();
          }),
        );
        read();
        return () => {
          for (const unsubscribe of unsubscribes) {
            unsubscribe();
          }
        };
      },
      get: () => snapshot,
    };
  }, [replica, key]);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** Runs and routes open on the scope's dashboard, and connections in Integrations. */
function pageLinks(scope: BackofficeResolvedScope) {
  return (target: BackofficeUiLinkTarget) => {
    switch (target.kind) {
      case "run":
        return dashboardRunPath(scope, target);
      case "route":
        return dashboardSelectionPath(scope, { kind: "route", id: target.id });
      case "connection":
        return integrationConnectionPath(scope, target.id);
      case "integrations":
        return integrationsScopeBasePath(scope);
      case "agents":
        return piAgentsPath(backofficeRouteScopeFromResolvedScope(scope));
    }
    throw new Error("Unsupported generated UI link target.");
  };
}
