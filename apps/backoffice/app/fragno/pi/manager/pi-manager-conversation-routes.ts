import { piAgentWatchFrameSchema } from "@fragno-dev/backoffice-api/v0/pi";
import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import {
  PiConversationViewDamagedError,
  piAgentCompactionStatusSchema,
  piAgentEntryPageRequestSchema,
  type PiAgentViewStreamFrame,
  type PiAgentWaitingQueue,
} from "@/fragno/pi/agent/pi-agent-contract";

import { piManagerDefinition } from "./pi-manager-definition";

/**
 * Interleaves `queue` frames with the agent's view frames. View frames pass through whole lines
 * only, so a queue frame never lands inside one.
 */
function withQueueFrames(
  views: ReadableStream<Uint8Array>,
  watchQueue: (listener: (queue: PiAgentWaitingQueue) => void) => () => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = views.getReader();
  let partial = "";
  let unwatch = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      unwatch = watchQueue(({ paused, items }) => {
        const frame: PiAgentViewStreamFrame = { type: "queue", paused, items };
        controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
      });
    },
    // Reads until it can pass on a whole line, since a pull that enqueues nothing is not repeated.
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read().catch((cause: unknown) => {
          // A stream that errors is never cancelled, so it stops following the queue here.
          unwatch();
          throw cause;
        });
        if (done) {
          unwatch();
          if (partial) {
            controller.enqueue(encoder.encode(partial));
          }
          controller.close();
          return;
        }
        partial += decoder.decode(value, { stream: true });
        const end = partial.lastIndexOf("\n") + 1;
        if (end > 0) {
          controller.enqueue(encoder.encode(partial.slice(0, end)));
          partial = partial.slice(end);
          return;
        }
      }
    },
    async cancel(reason) {
      unwatch();
      await reader.cancel(reason);
    },
  });
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
      path: "/agents/:agentName/view-stream",
      outputSchema: z.array(piAgentWatchFrameSchema),
      errorCodes: ["AGENT_NOT_STARTED", PiConversationViewDamagedError.code],
      handler: async function ({ pathParams }, { error }) {
        const { agentName } = pathParams;
        const { agent, queue } = await this.handlerTx()
          .withServiceCalls(
            () => [services.getAgents([agentName]), services.getWaitingQueue(agentName)] as const,
          )
          .transform(({ serviceResult: [agents, waiting] }) => ({
            agent: agents.get(agentName),
            queue: waiting,
          }))
          .execute();
        if (!agent) {
          return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
        }
        try {
          const views = await config.agent(agent).watchView(agent);
          const stream = withQueueFrames(views, (listener) =>
            config.queueChannel.watch(agentName, queue, listener),
          );
          return new Response(stream, {
            headers: {
              "cache-control": "no-cache",
              "content-type": "application/x-ndjson; charset=utf-8",
              "x-content-type-options": "nosniff",
            },
          });
        } catch (cause) {
          return damagedViewResponse(cause, error);
        }
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
      path: "/agents/:agentName/export",
      errorCodes: ["AGENT_NOT_STARTED"],
      handler: async function ({ pathParams }, { error }) {
        const agent = await this.handlerTx()
          .withServiceCalls(() => [services.getAgents([pathParams.agentName])])
          .transform(({ serviceResult: [agents] }) => agents.get(pathParams.agentName))
          .execute();
        if (!agent) {
          return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
        }
        return new Response(await config.agent(agent).exportEntries(agent), {
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
