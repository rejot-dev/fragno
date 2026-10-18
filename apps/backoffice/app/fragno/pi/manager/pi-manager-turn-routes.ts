import {
  piBillingOrganizationIdSchema,
  piPromptReceiptOutputSchema,
  piPromptWhenBusySchema,
  type PiAgentDefinition,
} from "@fragno-dev/backoffice-api/v0/pi";
import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";
import type { HookHandlerTx } from "@fragno-dev/db";

import { admitPiAgentTurn } from "@/fragno/pi/agent/agent-definitions";
import {
  piAgentCompactionSchema,
  piAgentNotificationSchema,
  piAgentPromptSchema,
  piAgentSubmissionWaitRequestSchema,
  piAgentSubmissionWaitSchema,
  piAgentTurnSchema,
} from "@/fragno/pi/agent/pi-agent-contract";

import { piManagerDefinition } from "./pi-manager-definition";
import type { PiAgentTurnProvenance } from "./pi-manager-schema";

// Middleware resolves identity and overwrites provenance before route validation.
const turnProvenanceSchema = piAgentTurnSchema.pick({ actors: true, scopeRestriction: true });
export const promptRequestSchema = z.object({
  requestId: z.string().trim().min(1).max(256).optional(),
  content: piAgentPromptSchema.shape.content,
  whenBusy: piPromptWhenBusySchema.default("followUp"),
  billingOrganizationId: piBillingOrganizationIdSchema.default(null),
});
const promptSchema = piAgentPromptSchema.extend({
  whenBusy: piPromptWhenBusySchema,
  billingOrganizationId: piBillingOrganizationIdSchema,
  provenance: turnProvenanceSchema,
});
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
              services.getQueueSubmission(agentName, requestId),
            ] as const,
        )
        .transform(({ serviceResult: [agents, held] }) => ({ agent: agents.get(agentName), held }))
        .execute();
    }

    async function admitTurn(
      definition: PiAgentDefinition | null,
      agentName: string,
      provenance: PiAgentTurnProvenance,
    ) {
      return admitPiAgentTurn(
        definition,
        agentName,
        provenance,
        await config.supportedAvailableModels(),
      );
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
          "PI_BILLING_OWNER_REQUIRED",
          "AGENT_BUSY",
        ],
        handler: async function ({ pathParams, input }, { json, error }) {
          const { provenance, billingOrganizationId, whenBusy, ...prompt } = await input.valid();
          const { agentName } = pathParams;
          const availableModels = await config.supportedAvailableModels();
          const submitted = await this.handlerTx()
            .withServiceCalls(
              () =>
                [
                  services.submitPrompt({
                    agentName,
                    prompt,
                    whenBusy,
                    provenance,
                    billingOrganizationId,
                    availableModels,
                  }),
                ] as const,
            )
            .transform(({ serviceResult: [result] }) => result)
            .execute();
          if (submitted.type === "error") {
            return error({ code: submitted.code, message: submitted.message }, submitted.status);
          }
          if (submitted.type === "billing-owner-required") {
            return error(
              {
                code: "PI_BILLING_OWNER_REQUIRED",
                message: "A user-scoped Pi agent's first turn requires a billing organization.",
              },
              400,
            );
          }
          if (submitted.type === "busy") {
            return error(
              {
                code: "AGENT_BUSY",
                message: `Agent "${agentName}" is running a turn; the prompt was not queued.`,
              },
              409,
            );
          }
          const { dispatch } = submitted;
          if (dispatch) {
            const agent = config.agent(dispatch.agent);
            try {
              await (submitted.type === "steered"
                ? agent.steer(dispatch.agent, dispatch.turn, dispatch.prompt)
                : agent.dispatch(dispatch.agent, dispatch.turn, dispatch.prompt));
            } catch (cause) {
              // The prompt is recorded, and the hook its submission triggered hands it over again.
              console.error(cause);
            }
          }
          return json({ requestId: prompt.requestId, status: submitted.type }, 202);
        },
      }),
      defineRoute({
        method: "POST",
        path: "/agents/:agentName/notifications",
        inputSchema: notificationSchema,
        errorCodes: ["AGENT_NOT_STARTED", "AGENT_NOT_FOUND", "MODEL_UNAVAILABLE"],
        handler: async function ({ pathParams, input }, { empty, error }) {
          const { provenance, ...notification } = await input.valid();
          const { definition, config: agentConfig } = await this.handlerTx()
            .withServiceCalls(() => [services.getAgent(pathParams.agentName)])
            .transform(({ serviceResult: [agent] }) => agent)
            .execute();
          // A notification never starts an agent: a personal agent has no billing owner to pick.
          if (!agentConfig) {
            return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
          }
          const admitted = await admitTurn(definition, pathParams.agentName, provenance);
          if (admitted.type === "error") {
            return error({ code: admitted.code, message: admitted.message }, admitted.status);
          }
          await config.agent(agentConfig).notify(agentConfig, admitted.turn, notification);
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
        method: "GET",
        path: "/agents/:agentName/submissions/:requestId/wait",
        queryParameters: ["waitMs"],
        outputSchema: piAgentSubmissionWaitSchema,
        errorCodes: ["AGENT_NOT_STARTED", "SUBMISSION_NOT_FOUND", "INVALID_WAIT_DURATION"],
        handler: async function ({ pathParams, query }, { json, error }) {
          const wait = piAgentSubmissionWaitRequestSchema.safeParse({
            waitMs: Number(query.get("waitMs")),
          });
          if (!wait.success) {
            return error(
              {
                code: "INVALID_WAIT_DURATION",
                message: "Pi submission wait duration is invalid.",
              },
              400,
            );
          }
          const { agent, held } = await findSubmission(() => this.handlerTx(), pathParams);
          if (!agent) {
            return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
          }
          if (held?.status === "dropped") {
            return json({ status: "settled", submission: held });
          }
          // A queued prompt reaches Pi only once its queue dispatches it, which the wait covers.
          if (!held && !(await config.agent(agent).getSubmission(agent, pathParams.requestId))) {
            return error(
              { code: "SUBMISSION_NOT_FOUND", message: "Pi submission was not found." },
              404,
            );
          }
          return json(
            await config.agent(agent).waitForSubmission(agent, pathParams.requestId, wait.data),
          );
        },
      }),
      defineRoute({
        method: "GET",
        path: "/agents/:agentName/submissions/:requestId",
        outputSchema: z.unknown(),
        errorCodes: ["AGENT_NOT_STARTED", "SUBMISSION_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          const { agent, held } = await findSubmission(() => this.handlerTx(), pathParams);
          if (!agent) {
            return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
          }
          if (held?.status === "dropped") {
            return json(held);
          }
          const submission = await config.agent(agent).getSubmission(agent, pathParams.requestId);
          if (submission ?? held) {
            return json(submission ?? held);
          }
          return error(
            { code: "SUBMISSION_NOT_FOUND", message: "Pi submission was not found." },
            404,
          );
        },
      }),
      defineRoute({
        method: "POST",
        path: "/agents/:agentName/abort",
        errorCodes: ["AGENT_NOT_STARTED"],
        handler: async function ({ pathParams }, { empty, error }) {
          const agent = await this.handlerTx()
            .withServiceCalls(
              () =>
                [
                  services.getAgents([pathParams.agentName]),
                  services.dropWaitingQueueItems(pathParams.agentName),
                ] as const,
            )
            .transform(({ serviceResult: [agents] }) => agents.get(pathParams.agentName))
            .execute();
          if (!agent) {
            return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
          }
          await config.agent(agent).abort(agent);
          return empty(204);
        },
      }),
    ];
  },
);
