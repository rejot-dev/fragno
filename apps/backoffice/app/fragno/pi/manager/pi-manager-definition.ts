import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";

import type {
  PiAgent,
  PiAgentAddress,
  PiAvailableModel,
} from "@/fragno/pi/agent/pi-agent-contract";

import { piAgentDirectoryServices } from "./pi-agent-directory-services";
import { piAgentQueueServices, type PiManagerHooks } from "./pi-agent-queue";
import { piAgentDirectorySchema } from "./pi-manager-schema";

export type PiManagerConfig = {
  scope: BackofficeContextScope;
  agent: (address: PiAgentAddress) => PiAgent;
  supportedAvailableModels: () => Promise<readonly PiAvailableModel[]>;
};

/** Execution scope is supplied by the object address, never by a request body. */
export const piManagerDefinition = defineFragment<PiManagerConfig>("pi-manager")
  .extend(withDatabase(piAgentDirectorySchema))
  .providesBaseService(({ defineService, config }) => ({
    ...piAgentDirectoryServices(defineService, config),
    ...piAgentQueueServices(defineService, config),
  }))
  .provideHooks<PiManagerHooks>(({ defineHook, services, config }) => ({
    redispatchAgentQueue: defineHook(async function ({ agentName }): Promise<void> {
      const { dispatched, steered } = await this.handlerTx()
        .withServiceCalls(() => [services.getUnsettledQueueItems(agentName)] as const)
        .transform(({ serviceResult: [items] }) => items)
        .execute();
      // Pi keeps the submission of a request ID it already has, so handing one over again is safe.
      for (const { agent, turn, prompt } of steered) {
        await config.agent(agent).steer(agent, turn, prompt);
      }
      if (dispatched) {
        const { agent, turn, prompt } = dispatched;
        await config.agent(agent).dispatch(agent, turn, prompt);
      }
    }),
  }))
  .build();
