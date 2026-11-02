import { MarkdownTextProvider } from "@fragno-private/backoffice-ui/markdown-text";
import { createContext, useContext, type ReactNode } from "react";

import { MarkdownText } from "@/routes/backoffice/agents/session-detail/message-content";

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
        <FileScopeProvider scope={value.resolvedScope}>
          <MarkdownTextProvider component={MarkdownText}>{children}</MarkdownTextProvider>
        </FileScopeProvider>
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
