import { createContext, useContext, type ReactNode } from "react";

import type { UploadProgress } from "@fragno-dev/upload";

import type { PreparedUploadedFileReference } from "@/fragno/prepared-upload";

import type { GeneratedUiUploadScope } from "./generated-ui-upload-scope";

export type WorkflowUiEventInput = {
  eventId: string;
  eventType: string;
  payload: unknown;
};

export type WorkflowUiFileUploadInput = {
  scope: GeneratedUiUploadScope;
  file: File;
  bindingPath?: string;
  onProgress: (progress: UploadProgress) => void;
};

export type WorkflowUiInteractionHost = {
  canEditInput(): boolean;
  canSendEvent(eventType: string): boolean;
  sendEvent(input: WorkflowUiEventInput): Promise<void>;
  uploadFile(input: WorkflowUiFileUploadInput): Promise<PreparedUploadedFileReference>;
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
