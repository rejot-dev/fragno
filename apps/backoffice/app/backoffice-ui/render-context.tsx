import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import type { BackofficeUiLinkTarget } from "./components/link";

/** Where a link leads in the current scope. */
export type BackofficeUiLinks = (target: BackofficeUiLinkTarget) => string;

/**
 * What components read besides their props. Every component of an interface reads one clock, so
 * relative times and chart axes agree with the queries that fed them. Interfaces outside a scope,
 * such as a marketplace preview, have no links, so links show their labels.
 */
type BackofficeUiRenderContextValue = { now: number; links: BackofficeUiLinks | null };

const BackofficeUiRenderContext = createContext<BackofficeUiRenderContextValue | null>(null);

export function BackofficeUiRenderContextProvider({
  now,
  links,
  children,
}: BackofficeUiRenderContextValue & { children: ReactNode }) {
  return <BackofficeUiRenderContext value={{ now, links }}>{children}</BackofficeUiRenderContext>;
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
 * live queries that read it restart once a minute.
 */
export function useMinuteClock(): number {
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
