import type { ReactNode } from "react";

import type { BackofficeResolvedScope } from "@/backoffice-runtime/resolved-scope";
import type { WorkflowRunCollections } from "@/routes/backoffice/automations/script-view/use-script-workflow-runs";

import type {
  SessionWorkspaceStateBySession,
  SessionWorkspaceStateUpdate,
} from "./session-detail/workspace-model";
import type { PiLayoutContext } from "./shared";

export type PiCreateSessionActionData = {
  intent: "create-session";
  ok: boolean;
  message?: string;
};

export type PiSessionsOutletContext = {
  resolvedScope: BackofficeResolvedScope;
  persistenceSource: NonNullable<PiLayoutContext["persistenceSource"]>;
  basePath: string;
  createSessionPanel?: ReactNode;
  startNewSession: () => void;
  workspaceStates: SessionWorkspaceStateBySession;
  updateWorkspaceState: (sessionKey: string, update: SessionWorkspaceStateUpdate) => void;
  workflowCollections?: WorkflowRunCollections;
  workflowCollectionsError: string | null;
};
