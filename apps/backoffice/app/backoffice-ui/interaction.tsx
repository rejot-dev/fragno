import { createContext, useContext, type ReactNode } from "react";

export type BackofficeUiWorkflowEventInput = {
  eventId: string;
  eventType: string;
  payload: unknown;
};

export type BackofficeUiInteractionHost = {
  canEditWorkflowInput?(): boolean;
  canSendWorkflowEvent(eventType: string): boolean;
  sendWorkflowEvent(input: BackofficeUiWorkflowEventInput): Promise<void>;
};

const BackofficeUiInteractionContext = createContext<BackofficeUiInteractionHost | null>(null);

export function BackofficeUiInteractionProvider({
  children,
  host,
}: {
  children: ReactNode;
  host?: BackofficeUiInteractionHost;
}) {
  return (
    <BackofficeUiInteractionContext.Provider value={host ?? null}>
      {children}
    </BackofficeUiInteractionContext.Provider>
  );
}

export function useBackofficeUiInteractionHost() {
  return useContext(BackofficeUiInteractionContext);
}
