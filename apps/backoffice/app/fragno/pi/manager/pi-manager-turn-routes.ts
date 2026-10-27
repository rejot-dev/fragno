import { automationEntityRefsEqual } from "@fragno-dev/backoffice-api/v0/automation";
import {
  piAgentConfigSchema,
  piPromptReceiptOutputSchema,
  piPromptWhenBusySchema,
  type PiAgentDefinition,
} from "@fragno-dev/backoffice-api/v0/pi";
import { backofficeContextScopesEqual } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";
import type { HookHandlerTx } from "@fragno-dev/db";

import { admitPiAgentTurn } from "@/fragno/pi/agent/agent-definitions";
import { piAgentActor } from "@/fragno/pi/agent/pi-agent-actor";
import {
  piAgentCompactionSchema,
  piAgentModelChoiceSchema,
  piAgentNotificationSchema,
  piAgentPromptSchema,
  piAgentTurnSchema,
} from "@/fragno/pi/agent/pi-agent-contract";

import { handOverPiAgentWork, publishPiAgentQueue, type PiAgentHandover } from "./pi-agent-queue";
import { piManagerDefinition } from "./pi-manager-definition";
import type { PiAgentTurnProvenance } from "./pi-manager-schema";

// Middleware resolves identity and overwrites provenance before route validation.
export const turnProvenanceSchema = piAgentTurnSchema.pick({
  actors: true,
  scopeRestriction: true,
});
// A person's message resumes a stopped agent's queue; automations wait until someone does.
const promptWhenPausedSchema = z.enum(["wait", "resume"]);
export const promptRequestSchema = z.object({
  requestId: z.string().trim().min(1).max(256).optional(),
  content: piAgentPromptSchema.shape.content,
  whenBusy: piPromptWhenBusySchema.default("followUp"),
  whenPaused: promptWhenPausedSchema.default("wait"),
  // A built-in agent's model for this prompt's turn; null keeps the conversation's.
  model: piAgentModelChoiceSchema.nullable().default(null),
  // The agent, in any scope, whose turn sends the prompt and is notified of how it ends.
  replyTo: piAgentConfigSchema.nullable().default(null),
});
const promptSchema = piAgentPromptSchema.extend({
  whenBusy: piPromptWhenBusySchema,
  whenPaused: promptWhenPausedSchema,
  model: piAgentModelChoiceSchema.nullable(),
  replyTo: piAgentConfigSchema.nullable(),
  provenance: turnProvenanceSchema,
});

/**
 * Only an agent's own turn, or work it persisted, acts with its delegate actor, so a reply is
 * always news of that agent's own work. The actor names the agent's scope, so this holds across
 * scopes.
 */
function repliesToSendingAgent(
  replyTo: z.infer<typeof piAgentConfigSchema>,
  provenance: PiAgentTurnProvenance,
) {
  const agent = piAgentActor(replyTo.scope, replyTo.agentName);
  return provenance.actors.delegation.some((actor) => automationEntityRefsEqual(actor, agent));
}
const compactionSchema = piAgentCompactionSchema.extend({ provenance: turnProvenanceSchema });
const notificationSchema = z.lazy(() =>
  piAgentNotificationSchema._zod.innerType.extend({ provenance: turnProvenanceSchema }),
);

/** Start, follow, and stop an agent's work; each turn runs with the requester's provenance. */
export const piManagerTurnRoutes = defineRoutes(piManagerDefinition).create(
  ({ defineRoute, services, config }) => {
    async function findSubmission(
      handlerTx: HookHandlerTx,
      { agentName, requestId }: { agentName: string; requestId: string },
    ) {
      return await handlerTx()
        .withServiceCalls(
          () =>
            [
              services.getAgents([agentName]),
              services.getQueueRecord(agentName, requestId),
            ] as const,
        )
        .transform(({ serviceResult: [agents, record] }) => ({
          agent: agents.get(agentName),
          record,
        }))
        .execute();
    }

    async function admitTurn(
      definition: PiAgentDefinition | null,
      agentName: string,
      provenance: PiAgentTurnProvenance,
    ) {
      // Compaction runs on the conversation's model, which a turn without a choice keeps.
      return admitPiAgentTurn(
        definition,
        agentName,
        provenance,
        await config.supportedAvailableModels(),
        null,
      );
    }

    async function handOver(handover: PiAgentHandover | null) {
      if (!handover) {
        return;
      }
      try {
        await handOverPiAgentWork(config.agent, handover);
      } catch (cause) {
        // The item is recorded, and the hook its placement triggered hands it over again.
        console.error(cause);
      }
    }

    return [
      defineRoute({
        method: "POST",
        path: "/agents/:agentName/prompts",
        inputSchema: promptSchema,
        outputSchema: piPromptReceiptOutputSchema,
        errorCodes: [
          "AGENT_NOT_FOUND",
          "MODEL_UNAVAILABLE",
          "MODEL_NOT_CHOOSABLE",
          "AGENT_BUSY",
          "REPLY_NOT_ALLOWED",
        ],
        handler: async function ({ pathParams, input }, { json, error }) {
          const { provenance, whenBusy, whenPaused, model, replyTo, ...prompt } =
            await input.valid();
          const { agentName } = pathParams;
          if (replyTo && !repliesToSendingAgent(replyTo, provenance)) {
            return error(
              {
                code: "REPLY_NOT_ALLOWED",
                message: "A prompt can notify only the agent whose turn sends it.",
              },
              400,
            );
          }
          // An agent prompting itself only queues another turn of its own conversation, and a
          // reply to it could wake it again and again.
          if (
            replyTo?.agentName === agentName &&
            backofficeContextScopesEqual(replyTo.scope, config.scope)
          ) {
            return error(
              {
                code: "REPLY_NOT_ALLOWED",
                message: `An agent cannot be notified of its own prompts: you are "${agentName}" in this scope. Prompt another agent, or drop notifyWhenDone.`,
              },
              400,
            );
          }
          const availableModels = await config.supportedAvailableModels();
          const submitted = await this.handlerTx()
            .withServiceCalls(
              () =>
                [
                  services.submitPrompt({
                    agentName,
                    prompt,
                    model,
                    whenBusy,
                    whenPaused,
                    provenance,
                    replyTo,
                    availableModels,
                  }),
                ] as const,
            )
            .transform(({ serviceResult: [result] }) => result)
            .execute();
          if (submitted.type === "error") {
            return error({ code: submitted.code, message: submitted.message }, submitted.status);
          }
          if (submitted.type === "busy") {
            return error(
              {
                code: "AGENT_BUSY",
                message: `Agent "${agentName}" is busy; the prompt was not queued.`,
              },
              409,
            );
          }
          await publishPiAgentQueue(
            config.agent({ scope: config.scope, agentName }),
            submitted.queue,
          );
          await handOver(submitted.handover);
          return json({ requestId: prompt.requestId, status: submitted.status }, 202);
        },
      }),
      defineRoute({
        method: "POST",
        path: "/agents/:agentName/notifications",
        inputSchema: notificationSchema,
        errorCodes: ["AGENT_NOT_STARTED", "AGENT_NOT_FOUND", "MODEL_UNAVAILABLE"],
        handler: async function ({ pathParams, input }, { empty, error }) {
          const { provenance, ...notification } = await input.valid();
          const { agentName } = pathParams;
          const availableModels = await config.supportedAvailableModels();
          const submitted = await this.handlerTx()
            .withServiceCalls(
              () =>
                [
                  services.submitNotification({
                    agentName,
                    notification,
                    provenance,
                    availableModels,
                  }),
                ] as const,
            )
            .transform(({ serviceResult: [result] }) => result)
            .execute();
          if (submitted.type === "not-started") {
            return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
          }
          if (submitted.type === "error") {
            return error({ code: submitted.code, message: submitted.message }, submitted.status);
          }
          await publishPiAgentQueue(
            config.agent({ scope: config.scope, agentName }),
            submitted.queue,
          );
          await handOver(submitted.handover);
          return empty(204);
        },
      }),
      defineRoute({
        method: "POST",
        path: "/agents/:agentName/compact",
        inputSchema: compactionSchema,
        outputSchema: z.object({ taskId: z.number().int().positive() }),
        errorCodes: ["AGENT_NOT_STARTED", "AGENT_NOT_FOUND", "MODEL_UNAVAILABLE"],
        handler: async function ({ pathParams, input }, { json, error }) {
          const { provenance, ...request } = await input.valid();
          const { definition, config: agent } = await this.handlerTx()
            .withServiceCalls(() => [services.getAgent(pathParams.agentName)])
            .transform(({ serviceResult: [agent] }) => agent)
            .execute();
          if (!agent) {
            return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
          }
          const admitted = await admitTurn(definition, pathParams.agentName, provenance);
          if (admitted.type === "error") {
            return error({ code: admitted.code, message: admitted.message }, admitted.status);
          }
          return json(await config.agent(agent).compact(agent, admitted.turn, request), 202);
        },
      }),
      defineRoute({
        method: "POST",
        path: "/agents/:agentName/reset",
        errorCodes: ["AGENT_NOT_STARTED"],
        handler: async function ({ pathParams }, { empty, error }) {
          const { config: agent } = await this.handlerTx()
            .withServiceCalls(() => [services.getAgent(pathParams.agentName)])
            .transform(({ serviceResult: [agent] }) => agent)
            .execute();
          if (!agent) {
            return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
          }
          await config.agent(agent).reset(agent);
          return empty(204);
        },
      }),
      defineRoute({
        method: "GET",
        path: "/agents/:agentName/submissions/:requestId",
        outputSchema: z.unknown(),
        errorCodes: ["AGENT_NOT_STARTED", "SUBMISSION_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          const { agent, record } = await findSubmission(() => this.handlerTx(), pathParams);
          if (!agent) {
            return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
          }
          if (record?.type === "held") {
            return json(record.submission);
          }
          // A turn's submission answers for every item it handled.
          const submission = await config
            .agent(agent)
            .getSubmission(agent, record ? record.turnRequestId : pathParams.requestId);
          if (submission) {
            return json(submission);
          }
          // A dispatched turn reads as queued until Pi has its submission.
          if (record) {
            return json({ type: "input", status: "queued", requestId: pathParams.requestId });
          }
          return error(
            { code: "SUBMISSION_NOT_FOUND", message: "Pi submission was not found." },
            404,
          );
        },
      }),
      defineRoute({
        method: "POST",
        path: "/agents/:agentName/stop",
        inputSchema: z.object({ provenance: turnProvenanceSchema }),
        errorCodes: ["AGENT_NOT_STARTED"],
        handler: async function ({ pathParams, input }, { empty, error }) {
          const { agentName } = pathParams;
          const { provenance } = await input.valid();
          const { agent, paused } = await this.handlerTx()
            .withServiceCalls(
              () =>
                [
                  services.getAgents([agentName]),
                  services.pauseAgentQueue(agentName, provenance),
                ] as const,
            )
            .transform(({ serviceResult: [agents, queue] }) => ({
              agent: agents.get(agentName),
              paused: queue,
            }))
            .execute();
          if (!agent || !paused) {
            return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
          }
          await publishPiAgentQueue(config.agent(agent), paused);
          await config.agent(agent).abort(agent);
          return empty(204);
        },
      }),
      defineRoute({
        method: "POST",
        path: "/agents/:agentName/resume",
        inputSchema: z.object({ provenance: turnProvenanceSchema }),
        errorCodes: ["AGENT_NOT_STARTED"],
        handler: async function ({ pathParams, input }, { empty, error }) {
          const { agentName } = pathParams;
          const { provenance } = await input.valid();
          const availableModels = await config.supportedAvailableModels();
          const resumed = await this.handlerTx()
            .withServiceCalls(
              () =>
                [services.resumeAgentQueue({ agentName, availableModels, provenance })] as const,
            )
            .transform(({ serviceResult: [result] }) => result)
            .execute();
          if (!resumed) {
            return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
          }
          await publishPiAgentQueue(
            config.agent({ scope: config.scope, agentName }),
            resumed.queue,
          );
          await handOver(resumed.handover);
          return empty(204);
        },
      }),
    ];
  },
);
