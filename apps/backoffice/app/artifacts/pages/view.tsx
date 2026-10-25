import type { BackofficeUiLinkTarget } from "@fragno-private/backoffice-ui/link";
import type { PageDefinition } from "@fragno-private/backoffice-ui/pages/definition";
import { PageView } from "@fragno-private/backoffice-ui/pages/view";
import {
  useMinuteClock,
  type BackofficeUiHostWidgets,
} from "@fragno-private/backoffice-ui/render-context";
import { useMemo } from "react";

import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { useCurrentBackofficeContext } from "@/components/backoffice/current-context";
import type { AutomationCollections } from "@/fragno/automation/tanstack/collections";
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
 * Renders a page over the current scope's collections, with links into that scope, and draws its
 * host widgets: the orchestration graph from the route's loader data, and the forms runs ask.
 */
export function BackofficePageView({
  definition,
  collections,
  orchestration,
}: {
  definition: PageDefinition;
  collections: AutomationCollections;
  orchestration: OrchestrationLoaderData;
}) {
  const { resolvedScope } = useCurrentBackofficeContext();
  const now = useMinuteClock();
  const links = useMemo(() => pageLinks(resolvedScope), [resolvedScope]);
  const widgets = useMemo(
    (): BackofficeUiHostWidgets => ({
      orchestration: () => (
        <ScopeOrchestration collections={collections} loaderData={orchestration} />
      ),
      workflowResponse: (run) => (
        <WorkflowRunResponse
          readSource={{ kind: "collections", collections }}
          resolvedScope={resolvedScope}
          run={run}
        />
      ),
    }),
    [collections, orchestration, resolvedScope],
  );
  return (
    <PageView
      definition={definition}
      sources={collections}
      now={now}
      links={links}
      widgets={widgets}
    />
  );
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
