import { define } from "gunshi";
import { baseArgs, createClientFromContext } from "../../utils/options.js";
import { pipeNdjson } from "../../utils/stream.js";

export const runsStreamCommand = define({
  name: "stream",
  description: "Start a streamed run (NDJSON)",
  args: {
    ...baseArgs,
    thread: {
      type: "string",
      short: "t",
      description: "Thread ID",
    },
    type: {
      type: "string",
      description: "Run type (agent|deep_research)",
    },
    "input-message-id": {
      type: "string",
      description: "Input message ID",
    },
    model: {
      type: "string",
      description: "Model ID",
    },
    "thinking-level": {
      type: "string",
      description: "Thinking level",
    },
    "system-prompt": {
      type: "string",
      description: "Override system prompt",
    },
  },
  run: async (ctx) => {
    const threadId = ctx.values["thread"] as string | undefined;
    if (!threadId) {
      throw new Error("Missing --thread");
    }

    const client = createClientFromContext(ctx);
    const response = await client.streamRun({
      threadId,
      type: ctx.values["type"] as string | undefined,
      inputMessageId: ctx.values["input-message-id"] as string | undefined,
      modelId: ctx.values["model"] as string | undefined,
      thinkingLevel: ctx.values["thinking-level"] as string | undefined,
      systemPrompt: ctx.values["system-prompt"] as string | undefined,
    });

    await pipeNdjson(response);
  },
});
