import { createContext, useContext, type ReactNode } from "react";

export type SessionWorkspaceNavigation = {
  hasItem: (itemId: string) => boolean;
  isItemSelected: (itemId: string) => boolean;
  toggleItem: (itemId: string) => void;
};

const SessionWorkspaceNavigationContext = createContext<SessionWorkspaceNavigation | null>(null);

export function SessionWorkspaceNavigationProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: SessionWorkspaceNavigation;
}) {
  return (
    <SessionWorkspaceNavigationContext.Provider value={value}>
      {children}
    </SessionWorkspaceNavigationContext.Provider>
  );
}

export function useSessionWorkspaceNavigation() {
  return useContext(SessionWorkspaceNavigationContext);
}
