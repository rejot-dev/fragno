import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import type { BackofficeUiLinkTarget } from "./components/link";

/** Where a link leads in the current scope. */
export type BackofficeUiLinks = (target: BackofficeUiLinkTarget) => string;

/** The run a workflow's interface belongs to, as links name it. */
export type BackofficeUiRun = { workflowName: string; instanceId: string };

/**
 * Parts of an interface only the host can draw, because they read more than a page's queries and
 * act with the viewer's authority: the scope's orchestration graph, and the form a waiting run asks
 * a person to answer.
 */
export type BackofficeUiHostWidgets = {
  orchestration: () => ReactNode;
  workflowResponse: (run: BackofficeUiRun) => ReactNode;
};

/**
 * What components read besides their props. Every component of an interface reads one clock, so
 * relative times and chart axes agree with the queries that fed them. Interfaces outside a scope,
 * such as a marketplace preview, have no links, so links show their labels. Only pages have host
 * widgets; elsewhere a widget says where it shows.
 */
type BackofficeUiRenderContextValue = {
  now: number;
  links: BackofficeUiLinks | null;
  widgets: BackofficeUiHostWidgets | null;
};

const BackofficeUiRenderContext = createContext<BackofficeUiRenderContextValue | null>(null);

export function BackofficeUiRenderContextProvider({
  now,
  links,
  widgets,
  children,
}: BackofficeUiRenderContextValue & { children: ReactNode }) {
  const value = useMemo(() => ({ now, links, widgets }), [now, links, widgets]);
  return <BackofficeUiRenderContext value={value}>{children}</BackofficeUiRenderContext>;
}

export function useBackofficeUiRenderContext(): BackofficeUiRenderContextValue {
  const value = useContext(BackofficeUiRenderContext);
  if (!value) {
    throw new Error("Generated UI components render inside a Backoffice UI renderer.");
  }
  return value;
}

const CLOCK_TICK_MS = 60_000;

/**
 * Relative times move with the wall clock. Whole minutes keep the time stable between ticks, so
 * live queries that read it restart once a minute. Each tick waits for the next minute boundary;
 * an interval counted from mount would lag the wall clock by up to a minute.
 */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => minuteStart(Date.now()));
  useEffect(() => {
    let timer: number;
    const scheduleTick = () => {
      timer = window.setTimeout(
        () => {
          setNow(minuteStart(Date.now()));
          scheduleTick();
        },
        CLOCK_TICK_MS - (Date.now() % CLOCK_TICK_MS),
      );
    };
    scheduleTick();
    return () => {
      window.clearTimeout(timer);
    };
  }, []);
  return now;
}

function minuteStart(time: number): number {
  return Math.floor(time / CLOCK_TICK_MS) * CLOCK_TICK_MS;
}
