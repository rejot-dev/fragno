import { createContext, useContext, type ReactNode } from "react";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type { AutomationCollectionSource } from "@/fragno/automation/tanstack/browser-database";

export type AutomationCollectionSourceState =
  | { status: "ready"; source: AutomationCollectionSource }
  | { status: "unavailable"; message: string };

export type CurrentBackofficeContext = {
  scope: BackofficeContextScope;
  automationCollectionSource: AutomationCollectionSourceState;
  projectCollectionSource: AutomationCollectionSourceState | null;
};

const CurrentBackofficeReactContext = createContext<CurrentBackofficeContext | null>(null);

export function CurrentBackofficeProvider({
  value,
  children,
}: {
  value: CurrentBackofficeContext;
  children: ReactNode;
}) {
  return (
    <CurrentBackofficeReactContext.Provider value={value}>
      {children}
    </CurrentBackofficeReactContext.Provider>
  );
}

export function useCurrentBackofficeContext(): CurrentBackofficeContext {
  const context = useContext(CurrentBackofficeReactContext);
  if (!context) {
    throw new Error("Current Backoffice context is unavailable outside BackofficeLayout.");
  }
  return context;
}
