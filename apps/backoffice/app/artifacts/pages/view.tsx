import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { Component, useEffect, useMemo, type ReactNode } from "react";

import { createStateStore, type StateStore } from "@json-render/react";
import { useLiveQuery } from "@tanstack/react-db";

import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import type { BackofficeUiLinkTarget } from "@/backoffice-ui/components/link";
import { useMinuteClock } from "@/backoffice-ui/render-context";
import { BackofficeUiStoreRenderer } from "@/backoffice-ui/renderer";
import { useCurrentBackofficeContext } from "@/components/backoffice/current-context";
import type { AutomationCollections } from "@/fragno/automation/tanstack/collections";
import { piAgentsPath } from "@/routes/backoffice/agents/path";
import { dashboardRunPath, dashboardSelectionPath } from "@/routes/backoffice/dashboard/path";
import {
  integrationConnectionPath,
  integrationsScopeBasePath,
} from "@/routes/backoffice/integrations/connection-paths";

import {
  pageDataPath,
  pageValuePath,
  type PageDefinition,
  type PageQuery,
  type PageValue,
} from "./definition";
import { pageQuery, pageRows, pageValue } from "./query";

type PageViewProps = { definition: PageDefinition; collections: AutomationCollections };

/** Renders a page's interface over its queries' live results. */
export function PageView(props: PageViewProps) {
  return (
    <PageErrorBoundary definition={props.definition}>
      <PageContent {...props} />
    </PageErrorBoundary>
  );
}

/**
 * Validation cannot foresee everything TanStack DB or a component rejects, so a page that throws
 * while rendering fails in place, leaving the views around it, such as its source, usable. A new
 * definition, built from an edited source, renders again.
 */
class PageErrorBoundary extends Component<
  { definition: PageDefinition; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidUpdate(previous: { definition: PageDefinition }) {
    if (previous.definition !== this.props.definition && this.state.error !== null) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error === null) {
      return this.props.children;
    }
    return (
      <BackofficeSystemState
        tone="error"
        label="Invalid page"
        title="This page could not be shown."
        description={this.state.error.message}
      />
    );
  }
}

function PageContent({ definition, collections }: PageViewProps) {
  const { resolvedScope } = useCurrentBackofficeContext();
  const now = useMinuteClock();
  // Every query starts empty, so bound props hold rows and values before the first results arrive.
  const store = useMemo(() => {
    const created = createStateStore({});
    for (const name of Object.keys(definition.queries)) {
      created.set(pageDataPath(name), []);
    }
    for (const [name, value] of Object.entries(definition.values)) {
      created.set(pageValuePath(name), value.whenEmpty);
    }
    return created;
  }, [definition]);
  const valuesByQuery = useMemo(
    () =>
      Object.fromEntries(
        Object.keys(definition.queries).map((query) => [
          query,
          Object.entries(definition.values).filter(([, value]) => value.query === query),
        ]),
      ),
    [definition],
  );
  const links = useMemo(() => pageLinks(resolvedScope), [resolvedScope]);

  return (
    <>
      {Object.entries(definition.queries).map(([name, query]) => (
        <PageQueryResults
          key={name}
          name={name}
          query={query}
          values={valuesByQuery[name] ?? []}
          collections={collections}
          now={now}
          store={store}
        />
      ))}
      <BackofficeUiStoreRenderer spec={definition.spec} store={store} now={now} links={links} />
    </>
  );
}

/** Keeps one query's live rows, and the values read from them, in the page's state. */
function PageQueryResults({
  name,
  query,
  values,
  collections,
  now,
  store,
}: {
  name: string;
  query: PageQuery;
  values: [string, PageValue][];
  collections: AutomationCollections;
  now: number;
  store: StateStore;
}) {
  const { data } = useLiveQuery({
    query: (builder) => pageQuery(builder, collections, query, now),
  });
  useEffect(() => {
    const rows = pageRows(data);
    store.set(pageDataPath(name), rows);
    for (const [valueName, value] of values) {
      store.set(pageValuePath(valueName), pageValue(value, rows));
    }
  }, [data, name, values, store]);
  return null;
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
