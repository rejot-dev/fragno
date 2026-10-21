import type { PiManagerAgentDirectory } from "@fragno-dev/backoffice-api/v0/pi";

import type { BackofficeResolvedScope } from "@/backoffice-runtime/resolved-scope";
import type { PiAvailableModel } from "@/fragno/pi/agent/pi-agent-contract";

import type {
  SessionWorkspaceStateBySession,
  SessionWorkspaceStateUpdate,
} from "./session-detail/workspace-model";

export type PiAgentsOutletContext = PiManagerAgentDirectory & {
  resolvedScope: BackofficeResolvedScope;
  basePath: string;
  usageLabel: string;
  availableModelOptions: PiAvailableModel[];
  dictationMountRoute: string | null;
  agentsError: string | null;
  workspaceStates: SessionWorkspaceStateBySession;
  updateWorkspaceState: (agentName: string, update: SessionWorkspaceStateUpdate) => void;
};
