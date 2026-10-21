import { useEffect, useMemo, useState } from "react";

import { createStateStore, type StateStore } from "@json-render/react";
import { useLiveQuery } from "@tanstack/react-db";

import { BackofficeUiStoreRenderer } from "@/backoffice-ui/renderer";
import type { AutomationCollections } from "@/fragno/automation/tanstack/collections";

import {
  pageDataPath,
  pageValuePath,
  type PageDefinition,
  type PageQuery,
  type PageValue,
} from "./definition";
import { pageQuery, pageRows, pageValueText } from "./query";

const CLOCK_TICK_MS = 60_000;

/** Renders a page's interface over its queries' live results. */
export function PageView({
  definition,
  collections,
}: {
  definition: PageDefinition;
  collections: AutomationCollections;
}) {
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
      <BackofficeUiStoreRenderer spec={definition.spec} store={store} />
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
      store.set(pageValuePath(valueName), pageValueText(value, rows));
    }
  }, [data, name, values, store]);
  return null;
}

/**
 * Relative times move with the wall clock. Whole minutes keep a query's `now` stable between
 * ticks, so only queries that read it restart, once a minute.
 */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => minuteStart(Date.now()));
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(minuteStart(Date.now()));
    }, CLOCK_TICK_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  return now;
}

function minuteStart(time: number): number {
  return Math.floor(time / CLOCK_TICK_MS) * CLOCK_TICK_MS;
}
