import { piAgentMessagePageSchema, piPromptStatusSchema } from "@fragno-dev/backoffice-api/v0/pi";
import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import { piAgentActorName } from "@/fragno/pi/agent/pi-agent-actor";
import {
  PiConversationViewDamagedError,
  piAgentCompactionStatusSchema,
  piAgentEntryPageRequestSchema,
  piAgentMessagePageRequestSchema,
  piPromptStatusOf,
  type PiSubagentRun,
} from "@/fragno/pi/agent/pi-agent-contract";

import type { PiAgentSubagentItem } from "./pi-agent-queue";
import { piManagerDefinition } from "./pi-manager-definition";

/** How many of an agent's latest subagents its list shows. */
const PI_AGENT_SUBAGENT_LIST_LIMIT = 50;

/**
 * Who asked for a subagent: its agent's own turn, from a tool call its page shows it under;
 * another agent's turn; an installed app; or a person.
 */
const piSubagentAskerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("turn"), toolCallId: z.string() }),
  z.object({ kind: z.literal("agent"), agentName: z.string() }),
  z.object({ kind: z.literal("app"), appId: z.string() }),
  z.object({ kind: z.literal("person") }),
]);

/**
 * An agent's latest subagents, newest first, and any running before them, so what runs is always
 * listed, as the agent's page lists them. `startedAt` and `answeredAt` are null until it starts
 * and answers; a completed `status` holds the answer.
 */
export const piAgentSubagentListSchema = z.object({
  subagents: z.array(
    z.object({
      requestId: z.string(),
      task: z.string(),
      askedAt: z.string(),
      askedBy: piSubagentAskerSchema,
      status: piPromptStatusSchema,
      startedAt: z.string().nullable(),
      answeredAt: z.string().nullable(),
    }),
  ),
});

function subagentAsker(item: PiAgentSubagentItem): z.infer<typeof piSubagentAskerSchema> {
  if (item.askingToolCall !== null) {
    return { kind: "turn", toolCallId: item.askingToolCall };
  }
  const { actors } = item.provenance;
  // The newest agent in the delegation is the one whose turn asked.
  const agent = actors.delegation
    .filter((actor) => actor.scope === "internal" && actor.type === "pi-agent")
    .at(-1);
  if (agent) {
    return { kind: "agent", agentName: piAgentActorName(agent) };
  }
  return actors.initiator.scope === "internal" && actors.initiator.type === "app"
    ? { kind: "app", appId: actors.initiator.id }
    : { kind: "person" };
}

/** Where a subagent stands: its queue state while it waits or once dropped, else Pi's submission. */
function subagentStatus(item: PiAgentSubagentItem, run: PiSubagentRun) {
  const { requestId, state } = item;
  if (state.status === "queued" || state.status === "dropped") {
    return piPromptStatusOf(
      requestId,
      { type: "input", requestId, ...(state.status === "queued" ? { status: "queued" } : state) },
      null,
    );
  }
  // A dispatched subagent reads as queued until Pi has its submission.
  return piPromptStatusOf(
    requestId,
    run.submission ?? { type: "input", status: "queued", requestId },
    run.answer,
  );
}

function isoTime(epochMs: number | null) {
  return epochMs === null ? null : new Date(epochMs).toISOString();
}

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
          return json(await config.agent(agent).getView(agent, null));
        } catch (cause) {
          return damagedViewResponse(cause, error);
        }
      },
    }),
    defineRoute({
      method: "GET",
      path: "/agents/:agentName/subagents",
      outputSchema: piAgentSubagentListSchema,
      handler: async function ({ pathParams }, { json }) {
        const { agent, subagents } = await this.handlerTx()
          .withServiceCalls(
            () =>
              [
                services.getAgents([pathParams.agentName]),
                services.listSubagents(pathParams.agentName, PI_AGENT_SUBAGENT_LIST_LIMIT),
              ] as const,
          )
          .transform(({ serviceResult: [agents, items] }) => ({
            agent: agents.get(pathParams.agentName),
            subagents: items,
          }))
          .execute();
        // An agent that never started has run no subagents.
        if (!agent) {
          return json({ subagents: [] });
        }
        const runs = await config.agent(agent).getSubagentRuns(
          agent,
          subagents.map(({ requestId }) => requestId),
        );
        return json({
          subagents: subagents.map((item, index) => {
            const run = runs[index];
            return {
              requestId: item.requestId,
              task: item.task,
              askedAt: item.submittedAt,
              askedBy: subagentAsker(item),
              status: subagentStatus(item, run),
              startedAt: isoTime(run.startedAt),
              answeredAt: isoTime(run.answeredAt),
            };
          }),
        });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/agents/:agentName/subagents/:requestId/view",
      // Pi owns this experimental structural view; the manager deliberately keeps it opaque.
      outputSchema: z.unknown(),
      errorCodes: ["AGENT_NOT_STARTED", "SUBAGENT_NOT_FOUND", PiConversationViewDamagedError.code],
      handler: async function ({ pathParams }, { json, error }) {
        const agent = await this.handlerTx()
          .withServiceCalls(() => [services.getAgents([pathParams.agentName])])
          .transform(({ serviceResult: [agents] }) => agents.get(pathParams.agentName))
          .execute();
        if (!agent) {
          return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
        }
        let view: unknown;
        try {
          view = await config.agent(agent).getView(agent, pathParams.requestId);
        } catch (cause) {
          return damagedViewResponse(cause, error);
        }
        // A subagent that waits has no conversation yet.
        return view === null
          ? error(
              {
                code: "SUBAGENT_NOT_FOUND",
                message: "No subagent of this agent runs that request.",
              },
              404,
            )
          : json(view);
      },
    }),
    defineRoute({
      method: "GET",
      path: "/agents/:agentName/entries",
      queryParameters: ["before", "cursor", "pageSize"],
      outputSchema: z.object({
        entries: z.array(z.unknown()),
        cursor: z.string().nullable(),
        hasNextPage: z.boolean(),
      }),
      errorCodes: ["AGENT_NOT_STARTED", "INVALID_BEFORE", "INVALID_CURSOR", "INVALID_PAGE_SIZE"],
      handler: async function ({ pathParams, query }, { json, error }) {
        const before = piAgentEntryPageRequestSchema.shape.before.safeParse(
          Number(query.get("before")),
        );
        if (!before.success) {
          return error(
            { code: "INVALID_BEFORE", message: "Pi entry history requires a `before` entry ID." },
            400,
          );
        }
        const pageSize = z.coerce
          .number()
          .int()
          .min(1)
          .max(256)
          .safeParse(query.get("pageSize") ?? 100);
        if (!pageSize.success) {
          return error(
            {
              code: "INVALID_PAGE_SIZE",
              message: "Pi entry page size must be between 1 and 256.",
            },
            400,
          );
        }
        let cursor: z.infer<typeof piAgentEntryPageRequestSchema>["cursor"] = null;
        const encodedCursor = query.get("cursor");
        if (encodedCursor) {
          try {
            cursor = piAgentEntryPageRequestSchema.shape.cursor.parse(
              JSON.parse(encodedCursor) as unknown,
            );
          } catch {
            return error({ code: "INVALID_CURSOR", message: "Invalid Pi entry cursor." }, 400);
          }
        }
        const agent = await this.handlerTx()
          .withServiceCalls(() => [services.getAgents([pathParams.agentName])])
          .transform(({ serviceResult: [agents] }) => agents.get(pathParams.agentName))
          .execute();
        if (!agent) {
          return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
        }
        const page = await config.agent(agent).listEntries(agent, {
          before: before.data,
          pageSize: pageSize.data,
          cursor,
        });
        return json({
          entries: [...page.entries],
          cursor: page.cursor === null ? null : JSON.stringify(page.cursor),
          hasNextPage: page.cursor !== null,
        });
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
