import {
  piAgentActivitySchema,
  piAgentEntryRangeSchema,
  piAgentHistoryPageSchema,
  piAgentMessagePageSchema,
  type PiSubagentSummary,
} from "@fragno-dev/backoffice-api/v0/pi";
import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import {
  PiConversationViewDamagedError,
  piAgentCompactionStatusSchema,
  piAgentMessagePageRequestSchema,
} from "@/fragno/pi/agent/pi-agent-contract";

import { piManagerDefinition } from "./pi-manager-definition";

/** A page of an agent's subagents, as `PiSubagentPage` says; Backoffice's own types check it. */
const piSubagentPageSchema = z.object({
  subagents: z.array(z.custom<PiSubagentSummary>()),
  older: z.object({ through: z.number(), cursor: z.string() }).nullable(),
});

/** Unlike an unstarted agent, a name no agent has is most likely a typo. */
function agentNotFoundMessage(agentName: string) {
  return `No agent in this scope is named '${agentName}'; pi.listAgents lists the scope's agents.`;
}

function damagedViewResponse<T>(
  cause: unknown,
  error: (body: { code: string; message: string }, status: 409) => T,
): T {
  if (!PiConversationViewDamagedError.is(cause)) {
    throw cause;
  }
  return error(
    {
      code: PiConversationViewDamagedError.code,
      message: PiConversationViewDamagedError.publicMessage,
    },
    409,
  );
}

/** Read a started agent's conversation; each route answers 404 until the agent's first turn. */
export const piManagerConversationRoutes = defineRoutes(piManagerDefinition).create(
  ({ defineRoute, services, config }) => [
    defineRoute({
      method: "GET",
      path: "/agents/:agentName/view",
      // Pi owns this experimental structural view; the manager deliberately keeps it opaque.
      outputSchema: z.unknown(),
      errorCodes: ["AGENT_NOT_STARTED", PiConversationViewDamagedError.code],
      handler: async function ({ pathParams }, { json, error }) {
        const agent = await this.handlerTx()
          .withServiceCalls(() => [services.getAgents([pathParams.agentName])])
          .transform(({ serviceResult: [agents] }) => agents.get(pathParams.agentName))
          .execute();
        if (!agent) {
          return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
        }
        try {
          return json(await config.agent(agent).getView(agent));
        } catch (cause) {
          return damagedViewResponse(cause, error);
        }
      },
    }),
    defineRoute({
      method: "GET",
      path: "/agents/:agentName/subagents",
      queryParameters: ["cursor"],
      outputSchema: piSubagentPageSchema,
      errorCodes: ["INVALID_SUBAGENT_CURSOR"],
      handler: async function ({ pathParams, query }, { json, error }) {
        const invalid = () =>
          error(
            {
              code: "INVALID_SUBAGENT_CURSOR",
              message: "`cursor` must be the `older.cursor` of a page of this agent's subagents.",
            },
            400,
          );
        const cursor = query.get("cursor");
        const agent = await this.handlerTx()
          .withServiceCalls(() => [services.getAgents([pathParams.agentName])])
          .transform(({ serviceResult: [agents] }) => agents.get(pathParams.agentName))
          .execute();
        // An agent that never started has run no subagents, and listed no page of them.
        if (!agent) {
          return cursor === null ? json({ subagents: [], older: null }) : invalid();
        }
        const page = await config.agent(agent).listSubagents(agent, cursor);
        return page ? json(page) : invalid();
      },
    }),
    defineRoute({
      method: "GET",
      path: "/agents/:agentName/entries",
      queryParameters: ["minEntryId", "maxEntryId", "order", "pageSize", "subagent"],
      outputSchema: piAgentHistoryPageSchema,
      errorCodes: ["AGENT_NOT_STARTED", "INVALID_ENTRY_RANGE"],
      handler: async function ({ pathParams, query }, { json, error }) {
        const range = piAgentEntryRangeSchema.safeParse({
          minEntryId: query.has("minEntryId") ? Number(query.get("minEntryId")) : undefined,
          maxEntryId: query.has("maxEntryId") ? Number(query.get("maxEntryId")) : undefined,
          order: query.get("order") ?? undefined,
          pageSize: query.has("pageSize") ? Number(query.get("pageSize")) : undefined,
        });
        if (!range.success) {
          return error(
            {
              code: "INVALID_ENTRY_RANGE",
              message:
                "Pi entry pages take positive `minEntryId` and `maxEntryId`, `order` `descending` or `ascending`, and a `pageSize` from 1 to 256.",
            },
            400,
          );
        }
        const agent = await this.handlerTx()
          .withServiceCalls(() => [services.getAgents([pathParams.agentName])])
          .transform(({ serviceResult: [agents] }) => agents.get(pathParams.agentName))
          .execute();
        if (!agent) {
          return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
        }
        const page = await config
          .agent(agent)
          .listEntries(agent, range.data, query.get("subagent"));
        return json({ entries: [...page.entries], more: page.more });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/agents/:agentName/messages",
      queryParameters: ["last", "before", "subagent"],
      outputSchema: piAgentMessagePageSchema,
      errorCodes: ["AGENT_NOT_FOUND", "AGENT_NOT_STARTED", "INVALID_MESSAGE_PAGE"],
      handler: async function ({ pathParams, query }, { json, error }) {
        const request = piAgentMessagePageRequestSchema.safeParse({
          last: Number(query.get("last") ?? 20),
          before: query.has("before") ? Number(query.get("before")) : null,
          subagent: query.get("subagent"),
        });
        if (!request.success) {
          return error(
            {
              code: "INVALID_MESSAGE_PAGE",
              message:
                "Pi messages take `last` between 1 and 100 and, optionally, a `before` entry ID.",
            },
            400,
          );
        }
        const { definition, config: agent } = await this.handlerTx()
          .withServiceCalls(() => [services.getAgent(pathParams.agentName)])
          .transform(({ serviceResult: [found] }) => found)
          .execute();
        // A deleted agent keeps its conversation, which stays readable.
        if (!agent) {
          return definition
            ? error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404)
            : error(
                { code: "AGENT_NOT_FOUND", message: agentNotFoundMessage(pathParams.agentName) },
                404,
              );
        }
        return json(await config.agent(agent).listMessages(agent, request.data));
      },
    }),
    defineRoute({
      method: "GET",
      path: "/agents/:agentName/activity",
      queryParameters: ["subagent"],
      outputSchema: piAgentActivitySchema,
      errorCodes: ["AGENT_NOT_FOUND", PiConversationViewDamagedError.code],
      handler: async function ({ pathParams, query }, { json, error }) {
        const { definition, config: agent } = await this.handlerTx()
          .withServiceCalls(() => [services.getAgent(pathParams.agentName)])
          .transform(({ serviceResult: [found] }) => found)
          .execute();
        // A deleted agent keeps its conversation, which stays readable; an agent with no turns yet,
        // whose first prompt may wait, has run nothing.
        if (!agent) {
          return definition
            ? json({ tools: [], omitted: 0 })
            : error(
                { code: "AGENT_NOT_FOUND", message: agentNotFoundMessage(pathParams.agentName) },
                404,
              );
        }
        try {
          return json(await config.agent(agent).getActivity(agent, query.get("subagent")));
        } catch (cause) {
          return damagedViewResponse(cause, error);
        }
      },
    }),
    defineRoute({
      method: "GET",
      path: "/agents/:agentName/export",
      errorCodes: ["AGENT_NOT_FOUND", "AGENT_NOT_STARTED"],
      handler: async function ({ pathParams, query }, { error }) {
        const { definition, config: agent } = await this.handlerTx()
          .withServiceCalls(() => [services.getAgent(pathParams.agentName)])
          .transform(({ serviceResult: [found] }) => found)
          .execute();
        // A deleted agent keeps its conversation, which stays readable.
        if (!agent) {
          return definition
            ? error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404)
            : error(
                { code: "AGENT_NOT_FOUND", message: agentNotFoundMessage(pathParams.agentName) },
                404,
              );
        }
        const history = query.get("history") === "true";
        return new Response(await config.agent(agent).exportEntries(agent, history), {
          headers: {
            "cache-control": "no-store",
            "content-disposition": `attachment; filename="pi-agent-${agent.agentName}.jsonl"`,
            "content-type": "application/x-ndjson; charset=utf-8",
            "x-content-type-options": "nosniff",
          },
        });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/agents/:agentName/compactions/:taskId",
      outputSchema: piAgentCompactionStatusSchema,
      errorCodes: ["AGENT_NOT_STARTED", "COMPACTION_NOT_FOUND"],
      handler: async function ({ pathParams }, { json, error }) {
        const agent = await this.handlerTx()
          .withServiceCalls(() => [services.getAgents([pathParams.agentName])])
          .transform(({ serviceResult: [agents] }) => agents.get(pathParams.agentName))
          .execute();
        if (!agent) {
          return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
        }
        const taskId = z.coerce.number().int().positive().safeParse(pathParams.taskId);
        const compaction = taskId.success
          ? await config.agent(agent).getCompaction(agent, taskId.data)
          : null;
        return compaction
          ? json(compaction)
          : error({ code: "COMPACTION_NOT_FOUND", message: "Pi compaction was not found." }, 404);
      },
    }),
  ],
);
