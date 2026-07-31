import type { ReactNode } from "react";

import type { PiHarnessConfig } from "@/fragno/pi/pi-shared";
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
  scope: PiLayoutContext["scope"];
  persistenceSource: NonNullable<PiLayoutContext["persistenceSource"]>;
  harnesses: PiHarnessConfig[];
  basePath: string;
  createSessionPanel?: ReactNode;
  workspaceStates: SessionWorkspaceStateBySession;
  updateWorkspaceState: (sessionKey: string, update: SessionWorkspaceStateUpdate) => void;
  workflowCollections?: WorkflowRunCollections;
  workflowCollectionsError: string | null;
};
