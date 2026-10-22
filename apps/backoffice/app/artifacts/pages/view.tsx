import type { BackofficeUiLinkTarget } from "@fragno-private/backoffice-ui/link";
import type { PageDefinition } from "@fragno-private/backoffice-ui/pages/definition";
import { PageView } from "@fragno-private/backoffice-ui/pages/view";
import { useMinuteClock } from "@fragno-private/backoffice-ui/render-context";
import { useMemo } from "react";

import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { useCurrentBackofficeContext } from "@/components/backoffice/current-context";
import type { AutomationCollections } from "@/fragno/automation/tanstack/collections";
import { piAgentsPath } from "@/routes/backoffice/agents/path";
import { dashboardRunPath, dashboardSelectionPath } from "@/routes/backoffice/dashboard/path";
import {
  integrationConnectionPath,
  integrationsScopeBasePath,
} from "@/routes/backoffice/integrations/connection-paths";

/** Renders a page over the current scope's collections, with links into that scope. */
export function BackofficePageView({
  definition,
  collections,
}: {
  definition: PageDefinition;
  collections: AutomationCollections;
}) {
  const { resolvedScope } = useCurrentBackofficeContext();
  const now = useMinuteClock();
  const links = useMemo(() => pageLinks(resolvedScope), [resolvedScope]);
  return <PageView definition={definition} sources={collections} now={now} links={links} />;
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
