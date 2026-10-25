import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { Component, useEffect, useMemo, type ReactNode } from "react";

import { createStateStore } from "@json-render/react";

import type { BackofficeUiHostWidgets, BackofficeUiLinks } from "../render-context";
import { BackofficeUiStoreRenderer } from "../renderer";
import { pageDataPath, pageValuePath, type PageDefinition } from "./definition";
import { pageRows, PageRowsError, pageValue, type PageData, type PageQueryResult } from "./rows";

/** One query's live result, as the host maintains it. */
export type PageQueryState =
  | { status: "loading" }
  | { status: "ready"; result: PageQueryResult }
  | { status: "error"; message: string };

type PageViewProps = {
  definition: PageDefinition;
  /**
   * Each query's result, by name, for the parameters `pageQueryParams` gives at `now`. A query
   * without one shows no rows yet.
   */
  results: Readonly<Record<string, PageQueryState>>;
  /** The clock the page's relative times read, such as `useMinuteClock()`. */
  now: number;
  links: BackofficeUiLinks;
  widgets: BackofficeUiHostWidgets;
};

/** Renders a page's interface over its queries' live results. */
export function PageView(props: PageViewProps) {
  return (
    <PageErrorBoundary definition={props.definition}>
      <PageContent {...props} />
    </PageErrorBoundary>
  );
}

/**
 * Validation cannot foresee everything a component rejects, so a page that throws while rendering
 * fails in place, leaving the views around it, such as its source, usable. A new definition, built
 * from an edited source, renders again.
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
    return <PageFailure message={this.state.error.message} />;
  }
}

function PageFailure({ message }: { message: string }) {
  return (
    <BackofficeSystemState
      tone="error"
      label="Invalid page"
      title="This page could not be shown."
      description={message}
    />
  );
}

function PageContent({ definition, results, now, links, widgets }: PageViewProps) {
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
  const decoded = useMemo(() => decodeResults(definition, results), [definition, results]);

  useEffect(() => {
    if (decoded.kind === "failed") {
      return;
    }
    for (const [name, rows] of Object.entries(decoded.rows)) {
      store.set(pageDataPath(name), rows);
    }
    for (const [name, value] of Object.entries(definition.values)) {
      const rows = decoded.rows[value.query];
      if (rows) {
        store.set(pageValuePath(name), pageValue(value, rows));
      }
    }
  }, [decoded, definition, store]);

  if (decoded.kind === "failed") {
    return <PageFailure message={decoded.message} />;
  }
  return (
    <BackofficeUiStoreRenderer
      spec={definition.spec}
      store={store}
      now={now}
      links={links}
      widgets={widgets}
    />
  );
}

/** The rows of every query that has a result, or why one cannot be shown. */
function decodeResults(
  definition: PageDefinition,
  results: Readonly<Record<string, PageQueryState>>,
): { kind: "decoded"; rows: Record<string, PageData[]> } | { kind: "failed"; message: string } {
  const rows: Record<string, PageData[]> = {};
  for (const [name, query] of Object.entries(definition.queries)) {
    const state = Object.hasOwn(results, name) ? results[name] : undefined;
    if (state?.status === "error") {
      return { kind: "failed", message: `queries.${name}: ${state.message}` };
    }
    if (state?.status !== "ready") {
      continue;
    }
    try {
      rows[name] = pageRows(query, state.result);
    } catch (error) {
      if (!(error instanceof PageRowsError)) {
        throw error;
      }
      return { kind: "failed", message: `queries.${name}: ${error.message}` };
    }
  }
  return { kind: "decoded", rows };
}
