import { createContext, useContext, type ReactNode } from "react";

import type { UploadProgress } from "@fragno-dev/upload";

import type { GeneratedUiUploadedFile, GeneratedUiUploadScope } from "./generated-ui-upload";

export type WorkflowUiEventInput = {
  eventId: string;
  eventType: string;
  payload: unknown;
};

export type WorkflowUiFileUploadInput = {
  scope: GeneratedUiUploadScope;
  file: File;
  /** The file the form held before this upload, which the new file replaces. */
  replaces: GeneratedUiUploadedFile | null;
  bindingPath?: string;
  onProgress: (progress: UploadProgress) => void;
};

export type WorkflowUiInteractionHost = {
  canEditInput(): boolean;
  canSendEvent(eventType: string): boolean;
  sendEvent(input: WorkflowUiEventInput): Promise<void>;
  uploadFile(input: WorkflowUiFileUploadInput): Promise<GeneratedUiUploadedFile>;
};

const WorkflowUiInteractionContext = createContext<WorkflowUiInteractionHost | null>(null);

export function WorkflowUiInteractionProvider({
  children,
  host,
}: {
  children: ReactNode;
  host?: WorkflowUiInteractionHost;
}) {
  return (
    <WorkflowUiInteractionContext.Provider value={host ?? null}>
      {children}
    </WorkflowUiInteractionContext.Provider>
  );
}

export function useWorkflowUiInteractionHost() {
  return useContext(WorkflowUiInteractionContext);
}
