import { createContext, useContext, type ReactNode } from "react";

import type { CurrentBackofficeContext } from "./current-context-state";
import { FileScopeProvider, LinkableScopesProvider } from "./file-scope";

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
      <LinkableScopesProvider resolveScope={value.resolveScope}>
        <FileScopeProvider scope={value.resolvedScope}>{children}</FileScopeProvider>
      </LinkableScopesProvider>
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
