import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";

import type { AutomationsObject } from "@/backoffice-runtime/object-registry";
import {
  PI_AGENT_AUTOMATION_EVENTS,
  PI_AUTOMATION_SOURCE,
  piAgentEventSubject,
} from "@/fragno/backoffice-capabilities/capabilities/pi";
import type { UsageBilling } from "@/fragno/billing/usage-billing";
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
  /** Where a scope's model usage is recorded. */
  billing: (scope: BackofficeContextScope) => UsageBilling;
  /** The scope's Automations, which record agent changes; null when the runtime has none. */
  automations: Pick<AutomationsObject, "ingestEvent"> | null;
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
    recordAgentChange: defineHook(async function (change): Promise<void> {
      await config.automations?.ingestEvent(
        {
          id: this.hookId.toString(),
          scope: config.scope,
          // Automations started by this event inherit the requester's ceiling, never a wider one.
          scopeRestriction: change.provenance.scopeRestriction,
          source: PI_AUTOMATION_SOURCE,
          eventType: PI_AGENT_AUTOMATION_EVENTS[change.kind].eventType,
          occurredAt: this.createdAt.toISOString(),
          payload: change.kind === "stopped" ? {} : { definition: change.definition },
          actors: change.provenance.actors,
          subject: piAgentEventSubject(config.scope, change.agentName),
          causation: { kind: "origin" },
        },
        { propagationContext: this.capturePropagationContext() },
      );
    }),
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
    deliverModelUsage: defineHook(async function (usage): Promise<void> {
      // Usage queued before owner attribution keeps its paying organization, even on retries.
      const billing = config.billing(
        "organizationId" in usage
          ? { kind: "org", orgId: z.string().parse(usage.organizationId) }
          : usage.event.scope,
      );
      if (billing.kind === "system") {
        return;
      }
      await billing.recordEvent(usage.event, {
        propagationContext: this.capturePropagationContext(),
      });
    }),
  }))
  .build();
