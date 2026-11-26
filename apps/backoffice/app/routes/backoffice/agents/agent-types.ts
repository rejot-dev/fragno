import type { BackofficeResolvedScope } from "@/backoffice-runtime/resolved-scope";
import type { PiAvailableModel } from "@/fragno/pi/agent/pi-agent-contract";

import type { PiAgentListing } from "./agent-activity";

/** The scope's agents, read from its synchronized `pi` events once they are. */
export type PiAgentDirectoryState =
  | { status: "loading" }
  | { status: "ready"; agents: PiAgentListing[]; now: number }
  | { status: "unavailable"; message: string };

export type PiAgentsOutletContext = {
  resolvedScope: BackofficeResolvedScope;
  directory: PiAgentDirectoryState;
  basePath: string;
  usageLabel: string;
  availableModelOptions: PiAvailableModel[];
  dictationMountRoute: string | null;
};
