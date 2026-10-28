import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";

import type { AutomationsCommands } from "@/backoffice-runtime/object-registry";
import type { UsageBilling } from "@/fragno/billing/usage-billing";
import {
  piAgentNotificationEvent,
  type PiAgent,
  type PiAgentAddress,
  type PiAgentNotification,
  type PiAvailableModel,
} from "@/fragno/pi/agent/pi-agent-contract";

import { piAgentChangeEvent, piAgentQueueEvent } from "./pi-agent-change-events";
import { piAgentDirectoryServices } from "./pi-agent-directory-services";
import { handOverPiAgentWork, piAgentQueueServices, type PiManagerHooks } from "./pi-agent-queue";
import { piAgentDirectorySchema, type PiAgentTurnProvenance } from "./pi-manager-schema";
import { piModelUsageServices } from "./pi-model-usage";

export type PiManagerConfig = {
  scope: BackofficeContextScope;
  agent: (address: PiAgentAddress) => PiAgent;
  supportedAvailableModels: () => Promise<readonly PiAvailableModel[]>;
  /** Where a scope's model usage is recorded. */
  billing: (scope: BackofficeContextScope) => UsageBilling;
  /** The scope's Automations, which record agent changes; null when the runtime has none. */
  automations: Pick<AutomationsCommands, "ingestEvent"> | null;
  /** Delivers an event to an agent of any scope, as its sender, through that scope's manager. */
  notifyAgent: (input: {
    agent: PiAgentAddress;
    provenance: PiAgentTurnProvenance;
    event: PiAgentNotification["event"];
  }) => Promise<void>;
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
        piAgentChangeEvent({
          id: this.hookId.toString(),
          scope: config.scope,
          occurredAt: this.createdAt,
          change,
        }),
        { propagationContext: this.capturePropagationContext() },
      );
    }),
    recordQueueChange: defineHook(async function (change): Promise<void> {
      await config.automations?.ingestEvent(
        piAgentQueueEvent({
          id: this.hookId.toString(),
          scope: config.scope,
          occurredAt: this.createdAt,
          change,
        }),
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
    recordSubagent: defineHook(async function ({ agent, requestId, subagent }): Promise<void> {
      await handOverPiAgentWork(config.agent, {
        type: "recordSubagent",
        agent,
        requestId,
        subagent,
      });
    }),
    replyToAgent: defineHook(async function ({ replyTo, provenance, ending }): Promise<void> {
      // The reply's ID is the receiving queue's deduplication key. Request IDs are unique only per
      // conversation, so same-named agents of two scopes can end prompts with the same event ID;
      // the hook's ID is unique and stays the same across retries.
      const id = this.hookId.toString();
      const event =
        ending.type === "settled"
          ? { ...ending.event, id }
          : piAgentNotificationEvent(
              piAgentQueueEvent({
                id,
                scope: config.scope,
                occurredAt: this.createdAt,
                change: { kind: "dropped", ...ending, provenance },
              }),
            );
      await config.notifyAgent({ agent: replyTo, provenance, event });
    }),
    deliverModelUsage: defineHook(async function (usage): Promise<void> {
      // Usage queued before owner attribution keeps its paying organization, even on retries.
      // It predates jurisdictions, so its organization names none.
      const billing = config.billing(
        "organizationId" in usage
          ? { kind: "org", orgId: z.string().parse(usage.organizationId), jurisdiction: null }
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
