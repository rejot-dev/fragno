import type { PiManagerSession } from "@fragno-dev/backoffice-api/v0/pi";
import type { ReactNode } from "react";

import type { BackofficeResolvedScope } from "@/backoffice-runtime/resolved-scope";
import type { PiAvailableModel } from "@/fragno/pi-manager/pi-agent-contract";

import type {
  SessionWorkspaceStateBySession,
  SessionWorkspaceStateUpdate,
} from "./session-detail/workspace-model";

export type PiCreateSessionActionData = {
  intent: "create-session";
  ok: boolean;
  message?: string;
};

export type PiSessionsOutletContext = {
  resolvedScope: BackofficeResolvedScope;
  basePath: string;
  createSessionPanel?: ReactNode;
  startNewSession: () => void;
  availableModelOptions: PiAvailableModel[];
  sessions: PiManagerSession[];
  sessionsError: string | null;
  workspaceStates: SessionWorkspaceStateBySession;
  updateWorkspaceState: (sessionId: string, update: SessionWorkspaceStateUpdate) => void;
};
