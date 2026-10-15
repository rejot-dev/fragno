import { Type } from "typebox";

import { defineTool } from "@earendil-works/pi-durable";

import {
  requirePiStateBackend,
  type BackofficeAgentContext,
} from "@/fragno/pi/agent/backoffice-agent-context";

const readParametersSchema = Type.Object({
  path: Type.String({
    description: "Path to the file to read (relative or absolute).",
  }),
  offset: Type.Optional(
    Type.Number({
      description: "Line number to start reading from (1-indexed).",
    }),
  ),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read." })),
});

const normalizeReadPath = (path: string) => (path.startsWith("/") ? path : `/${path}`);

const applyLineRange = (content: string, offset?: number, limit?: number) => {
  if (offset === undefined && limit === undefined) {
    return content;
  }

  const lines = content.split("\n");
  const startIndex = offset === undefined ? 0 : Math.max(0, Math.trunc(offset) - 1);
  const endIndex = limit === undefined ? undefined : startIndex + Math.max(0, Math.trunc(limit));
  return lines.slice(startIndex, endIndex).join("\n");
};

export function createReadTool(agent: BackofficeAgentContext) {
  return defineTool({
    name: "read",
    description:
      "Read a known skill or TypeScript declaration from the combined Pi agent filesystem. Read selected skills in full before applying them.",
    parameters: readParametersSchema,
    replay: "safe",
    async execute(params, api, context) {
      const turn = await agent.activeTurn(context);
      await turn.authorize();
      if (context.abortSignal?.aborted) {
        throw new Error("Read aborted.");
      }

      const state = requirePiStateBackend(
        turn.toolContext(`${agent.agentName}:${api.taskId}`, context),
      );
      const path = normalizeReadPath(params.path);
      const text = applyLineRange(await state.readFile(path), params.offset, params.limit);
      return {
        content: [{ type: "text", text }],
        details: {
          path,
          offset: params.offset ?? null,
          limit: params.limit ?? null,
        },
      };
    },
  });
}
