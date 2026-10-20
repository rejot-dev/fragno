import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";

import type { BillingObject } from "@/backoffice-runtime/object-registry";
import type {
  PiAgent,
  PiAgentAddress,
  PiAvailableModel,
} from "@/fragno/pi/agent/pi-agent-contract";

import { piAgentDirectoryServices } from "./pi-agent-directory-services";
import {
  handOverPiAgentWork,
  piAgentQueueServices,
  type PiAgentQueueChannel,
  type PiManagerHooks,
} from "./pi-agent-queue";
import { piAgentDirectorySchema } from "./pi-manager-schema";
import { piModelUsageServices } from "./pi-model-usage";

export type PiManagerConfig = {
  scope: BackofficeContextScope;
  agent: (address: PiAgentAddress) => PiAgent;
  supportedAvailableModels: () => Promise<readonly PiAvailableModel[]>;
  /** One per manager object, which runs every request that changes its agents' queues. */
  queueChannel: PiAgentQueueChannel;
  /** The Billing object of an organization that pays for model calls. */
  billing: (organizationId: string) => Pick<BillingObject, "recordEvent">;
};

/** Execution scope is supplied by the object address, never by a request body. */
export const piManagerDefinition = defineFragment<PiManagerConfig>("pi-manager")
  .extend(withDatabase(piAgentDirectorySchema))
  .providesBaseService(({ defineService, config }) => ({
    ...piAgentDirectoryServices(defineService, config),
    ...piAgentQueueServices(defineService, config),
    ...piModelUsageServices(defineService),
  }))
  .provideHooks<PiManagerHooks>(({ defineHook, services, config }) => ({
    redispatchAgentQueue: defineHook(async function ({ agentName }): Promise<void> {
      const handovers = await this.handlerTx()
        .withServiceCalls(() => [services.getUnsettledHandovers(agentName)] as const)
        .transform(({ serviceResult: [unsettled] }) => unsettled)
        .execute();
      // Pi keeps the submission of a request ID it already has, so handing one over again is safe.
      for (const handover of handovers) {
        await handOverPiAgentWork(config.agent, handover);
      }
    }),
    writeNotificationCards: defineHook(async function ({ agent, notifications }): Promise<void> {
      await handOverPiAgentWork(config.agent, { type: "write", agent, notifications });
    }),
    deliverModelUsage: defineHook(async function ({ organizationId, event }): Promise<void> {
      await config.billing(organizationId).recordEvent(event, {
        propagationContext: this.capturePropagationContext(),
      });
    }),
  }))
  .build();
