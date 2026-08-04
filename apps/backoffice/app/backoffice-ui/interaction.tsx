import { createContext, useContext, type ReactNode } from "react";

import type { UploadProgress } from "@fragno-dev/upload";

import type { PreparedUploadedFileReference } from "@/fragno/prepared-upload";

import type { GeneratedUiUploadScope } from "./generated-ui-upload-scope";

export type BackofficeUiWorkflowEventInput = {
  eventId: string;
  eventType: string;
  payload: unknown;
};

export type BackofficeUiFileUploadInput = {
  scope: GeneratedUiUploadScope;
  file: File;
  bindingPath?: string;
  onProgress: (progress: UploadProgress) => void;
};

export type BackofficeUiInteractionHost = {
  canEditWorkflowInput?(): boolean;
  canSendWorkflowEvent(eventType: string): boolean;
  sendWorkflowEvent(input: BackofficeUiWorkflowEventInput): Promise<void>;
  uploadPreparedFile?(input: BackofficeUiFileUploadInput): Promise<PreparedUploadedFileReference>;
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
