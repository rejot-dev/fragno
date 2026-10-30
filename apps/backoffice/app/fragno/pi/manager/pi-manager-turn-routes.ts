import { automationEntityRefsEqual } from "@fragno-dev/backoffice-api/v0/automation";
import {
  piAgentConfigSchema,
  piPromptReceiptOutputSchema,
  piPromptStatusSchema,
  piPromptWhenBusySchema,
  type PiAgentDefinition,
} from "@fragno-dev/backoffice-api/v0/pi";
import { backofficeContextScopesEqual } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";
import type { HookHandlerTx } from "@fragno-dev/db";

import { checkUsageLimits } from "@/fragno/billing/usage-billing";
import { admitPiAgentTurn } from "@/fragno/pi/agent/agent-definitions";
import { piAgentActor } from "@/fragno/pi/agent/pi-agent-actor";
import {
  isPiInternalRequestId,
  PI_INTERNAL_REQUEST_ID_PREFIX,
  piAgentCompactionSchema,
  piAgentModelChoiceSchema,
  piAgentNotificationSchema,
  piAgentPromptSchema,
  piAgentTurnSchema,
  piPromptStatusOf,
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
  requestId: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .refine((requestId) => !isPiInternalRequestId(requestId), {
      message: `Request IDs starting with ${Object.values(PI_INTERNAL_REQUEST_ID_PREFIX).join(", ")} are reserved for Backoffice's own work.`,
    })
    .optional(),
  content: piAgentPromptSchema.shape.content,
  whenBusy: piPromptWhenBusySchema.default("followUp"),
  whenPaused: promptWhenPausedSchema.default("wait"),
  // A built-in agent's model for this prompt's turn; null keeps the conversation's.
  model: piAgentModelChoiceSchema.nullable().default(null),
  // The agent, in any scope, whose turn sends the prompt and is notified of how it ends.
  replyTo: piAgentConfigSchema.nullable().default(null),
  // Runs the prompt in a new conversation of the agent, beside its own.
  subagent: z.boolean().default(false),
  // The tool call of the agent's own turn that starts the subagent, which its page shows it under.
  askingToolCall: z.string().min(1).nullable().default(null),
});
const promptSchema = piAgentPromptSchema.extend({
  subagent: z.boolean(),
  whenBusy: piPromptWhenBusySchema,
  whenPaused: promptWhenPausedSchema,
  model: piAgentModelChoiceSchema.nullable(),
  replyTo: piAgentConfigSchema.nullable(),
  askingToolCall: z.string().min(1).nullable(),
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

    async function handOver(handovers: readonly PiAgentHandover[]) {
      for (const handover of handovers) {
        try {
          await handOverPiAgentWork(config.agent, handover);
        } catch (cause) {
          // The item is recorded, and the hook its placement triggered hands it over again.
          console.error(cause);
        }
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
          "SUBAGENT_NOT_BUSY",
          "AGENT_UNAVAILABLE",
          "ASKING_TOOL_CALL_NOT_ALLOWED",
          "USAGE_LIMIT_EXCEEDED",
        ],
        handler: async function ({ pathParams, input }, { json, error }) {
          const {
            provenance,
            subagent,
            whenBusy,
            whenPaused,
            model,
            replyTo,
            askingToolCall,
            ...prompt
          } = await input.valid();
          const { agentName } = pathParams;
          // Only the agent's own turn, acting with its delegate actor, asks from its tool calls.
          if (
            askingToolCall !== null &&
            !(
              subagent &&
              provenance.actors.delegation.some((actor) =>
                automationEntityRefsEqual(actor, piAgentActor(config.scope, agentName)),
              )
            )
          ) {
            return error(
              {
                code: "ASKING_TOOL_CALL_NOT_ALLOWED",
                message: "Only an agent's own turn starts subagents from its tool calls.",
              },
              400,
            );
          }
          if (replyTo && !repliesToSendingAgent(replyTo, provenance)) {
            return error(
              {
                code: "REPLY_NOT_ALLOWED",
                message: "A prompt can notify only the agent whose turn sends it.",
              },
              400,
            );
          }
          // A subagent runs in a conversation of its own, so it never steers or is refused as busy.
          if (subagent && whenBusy !== "followUp") {
            return error(
              {
                code: "SUBAGENT_NOT_BUSY",
                message: `A subagent starts in a new conversation, which is never busy; drop whenBusy "${whenBusy}".`,
              },
              400,
            );
          }
          // An agent prompting itself only queues another turn of its own conversation, and a
          // reply to it could wake it again and again. Its subagent replies once, from another.
          if (
            !subagent &&
            replyTo?.agentName === agentName &&
            backofficeContextScopesEqual(replyTo.scope, config.scope)
          ) {
            return error(
              {
                code: "REPLY_NOT_ALLOWED",
                message: `An agent cannot be notified of its own prompts: you are "${agentName}" in this scope. Start a subagent of yourself, prompt another agent, or drop notifyWhenDone.`,
              },
              400,
            );
          }
          // Turns already admitted run to completion, so usage can end a little past the limit.
          const [allowance, availableModels] = await Promise.all([
            checkUsageLimits(config.billing(config.scope), ["ai.cost.total"]),
            config.supportedAvailableModels(),
          ]);
          const submitted = await this.handlerTx()
            .withServiceCalls(
              () =>
                [
                  services.submitPrompt({
                    agentName,
                    prompt,
                    subagent: subagent ? { askingToolCall } : null,
                    submittedAt: new Date(),
                    model,
                    whenBusy,
                    whenPaused,
                    provenance,
                    replyTo,
                    availableModels,
                    allowance,
                  }),
                ] as const,
            )
            .transform(({ serviceResult: [result] }) => result)
            .execute();
          if (submitted.type === "error") {
            return error({ code: submitted.code, message: submitted.message }, submitted.status);
          }
          if (submitted.type === "limited") {
            return error({ code: "USAGE_LIMIT_EXCEEDED", message: submitted.message }, 403);
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
          // A turn may wait for a subagent as soon as it has its request ID, and waiting finds only
          // subagents its agent knows of, so the ID is returned only once the agent does.
          try {
            for (const handover of submitted.handovers) {
              if (handover.type === "recordSubagent") {
                await handOverPiAgentWork(config.agent, handover);
              }
            }
          } catch (cause) {
            console.error(cause);
            return error(
              {
                code: "AGENT_UNAVAILABLE",
                message: `Subagent "${prompt.requestId}" is queued, but agent "${agentName}" could not record it yet. Submit it again with requestId "${prompt.requestId}"; a new request ID would start a second subagent.`,
              },
              503,
            );
          }
          await handOver(submitted.handovers.filter(({ type }) => type !== "recordSubagent"));
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
          await handOver(submitted.handovers);
          return empty(204);
        },
      }),
      defineRoute({
        method: "POST",
        path: "/agents/:agentName/compact",
        inputSchema: compactionSchema,
        outputSchema: z.object({ taskId: z.number().int().positive() }),
        errorCodes: [
          "AGENT_NOT_STARTED",
          "AGENT_NOT_FOUND",
          "MODEL_UNAVAILABLE",
          "USAGE_LIMIT_EXCEEDED",
        ],
        handler: async function ({ pathParams, input }, { json, error }) {
          const { provenance, ...request } = await input.valid();
          // A manual compaction is a new model call; compactions within a turn are not checked.
          const [allowance, { definition, config: agent }] = await Promise.all([
            checkUsageLimits(config.billing(config.scope), ["ai.cost.total"]),
            this.handlerTx()
              .withServiceCalls(() => [services.getAgent(pathParams.agentName)])
              .transform(({ serviceResult: [agent] }) => agent)
              .execute(),
          ]);
          if (!agent) {
            return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
          }
          if (allowance.kind === "exhausted") {
            return error({ code: "USAGE_LIMIT_EXCEEDED", message: allowance.message }, 403);
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
        path: "/agents/:agentName/prompts/:requestId",
        outputSchema: piPromptStatusSchema,
        errorCodes: ["AGENT_NOT_STARTED", "PROMPT_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          const { requestId } = pathParams;
          const { agent, record } = await findSubmission(() => this.handlerTx(), pathParams);
          if (!agent) {
            return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
          }
          if (record?.type === "held") {
            return json(piPromptStatusOf(requestId, record.submission, null));
          }
          // A turn's submission answers for every item it handled.
          const submission = await config
            .agent(agent)
            .getSubmission(agent, record ? record.turnRequestId : requestId);
          if (submission) {
            return json(piPromptStatusOf(requestId, submission.record, submission.answer));
          }
          // A dispatched turn reads as queued until Pi has its submission.
          if (record) {
            return json({ requestId, status: "queued" });
          }
          return error({ code: "PROMPT_NOT_FOUND", message: "Pi prompt was not found." }, 404);
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
          await config.agent(agent).abort(agent, paused.revision);
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
          await handOver(resumed.handovers);
          return empty(204);
        },
      }),
    ];
  },
);
