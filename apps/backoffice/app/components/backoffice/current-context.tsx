import { createContext, useContext, type ReactNode } from "react";

import type {
  BackofficeOrganizationIdentity,
  BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import type { Organization } from "@/fragno/auth/contracts";
import type { AutomationCollectionSource } from "@/fragno/automation/tanstack/browser-database";

export type AutomationCollectionSourceState<
  TOrganization extends BackofficeOrganizationIdentity = BackofficeOrganizationIdentity,
> =
  | { status: "ready"; source: AutomationCollectionSource<TOrganization> }
  | {
      status: "unavailable";
      resolvedScope: BackofficeResolvedScope<TOrganization>;
      message: string;
    };

export type CurrentBackofficeContext = {
  automationCollectionSource: AutomationCollectionSourceState<Organization>;
  projectCollectionSource: AutomationCollectionSourceState<Organization> | null;
};

export function automationCollectionResolvedScope<
  TOrganization extends BackofficeOrganizationIdentity,
>(
  sourceState: AutomationCollectionSourceState<TOrganization>,
): BackofficeResolvedScope<TOrganization> {
  return sourceState.status === "ready"
    ? sourceState.source.resolvedScope
    : sourceState.resolvedScope;
}

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
