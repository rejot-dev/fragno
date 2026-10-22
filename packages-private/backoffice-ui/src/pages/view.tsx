import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { Component, useEffect, useMemo, type ReactNode } from "react";

import { createStateStore, type StateStore } from "@json-render/react";
import { useLiveQuery } from "@tanstack/react-db";

import type { BackofficeUiHostWidgets, BackofficeUiLinks } from "../render-context";
import { BackofficeUiStoreRenderer } from "../renderer";
import {
  pageDataPath,
  pageValuePath,
  type PageDefinition,
  type PageQuery,
  type PageValue,
} from "./definition";
import { pageQuery, pageRows, pageValue, type PageSources } from "./query";

type PageViewProps = {
  definition: PageDefinition;
  sources: PageSources;
  /** The clock the page's queries and relative times read, such as `useMinuteClock()`. */
  now: number;
  links: BackofficeUiLinks;
  widgets: BackofficeUiHostWidgets;
};

/** Renders a page's interface over its queries' live results from the host's collections. */
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
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidUpdate(previous: { definition: PageDefinition }) {
    if (previous.definition !== this.props.definition && this.state.error !== null) {
      this.setState({ error: null });
    }
  }

  override render() {
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

function PageContent({ definition, sources, now, links, widgets }: PageViewProps) {
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

  return (
    <>
      {Object.entries(definition.queries).map(([name, query]) => (
        <PageQueryResults
          key={name}
          name={name}
          query={query}
          values={valuesByQuery[name] ?? []}
          sources={sources}
          now={now}
          store={store}
        />
      ))}
      <BackofficeUiStoreRenderer
        spec={definition.spec}
        store={store}
        now={now}
        links={links}
        widgets={widgets}
      />
    </>
  );
}

/** Keeps one query's live rows, and the values read from them, in the page's state. */
function PageQueryResults({
  name,
  query,
  values,
  sources,
  now,
  store,
}: {
  name: string;
  query: PageQuery;
  values: [string, PageValue][];
  sources: PageSources;
  now: number;
  store: StateStore;
}) {
  const { data } = useLiveQuery({
    query: (builder) => pageQuery(builder, sources, query, now),
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
