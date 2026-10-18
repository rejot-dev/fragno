import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";

import type {
  PiAgent,
  PiAgentAddress,
  PiAvailableModel,
} from "@/fragno/pi/agent/pi-agent-contract";

import { piAgentDirectoryServices } from "./pi-agent-directory-services";
import { piAgentDirectorySchema } from "./pi-manager-schema";

export type PiManagerConfig = {
  scope: BackofficeContextScope;
  agent: (address: PiAgentAddress) => PiAgent;
  supportedAvailableModels: () => Promise<readonly PiAvailableModel[]>;
};

/** Execution scope is supplied by the object address, never by a request body. */
export const piManagerDefinition = defineFragment<PiManagerConfig>("pi-manager")
  .extend(withDatabase(piAgentDirectorySchema))
  .providesBaseService(({ defineService, config }) =>
    piAgentDirectoryServices(defineService, config),
  )
  .build();
