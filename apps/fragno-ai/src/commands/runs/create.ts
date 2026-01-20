import { define } from "gunshi";
import { baseArgs, createClientFromContext } from "../../utils/options.js";
import { formatJson } from "../../utils/format.js";
import { pipeNdjson } from "../../utils/stream.js";

const resolveExecutionMode = (value: string | undefined) => {
  if (!value) {
    return undefined;
  }
  if (value === "stream") {
    return "foreground_stream";
  }
  if (value === "background") {
    return "background";
  }
  return value;
};

export const runsCreateCommand = define({
  name: "create",
  description: "Create a run",
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
    mode: {
      type: "string",
      description: "Execution mode (background|stream)",
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
    json: {
      type: "boolean",
      description: "Output JSON",
    },
  },
  run: async (ctx) => {
    const threadId = ctx.values["thread"] as string | undefined;
    if (!threadId) {
      throw new Error("Missing --thread");
    }

    const mode = ctx.values["mode"] as string | undefined;
    const executionMode = resolveExecutionMode(mode);
    const client = createClientFromContext(ctx);

    if (executionMode === "foreground_stream") {
      const response = await client.streamRun({
        threadId,
        type: ctx.values["type"] as string | undefined,
        inputMessageId: ctx.values["input-message-id"] as string | undefined,
        modelId: ctx.values["model"] as string | undefined,
        thinkingLevel: ctx.values["thinking-level"] as string | undefined,
        systemPrompt: ctx.values["system-prompt"] as string | undefined,
      });

      await pipeNdjson(response);
      return;
    }

    const run = await client.createRun({
      threadId,
      type: ctx.values["type"] as string | undefined,
      executionMode,
      inputMessageId: ctx.values["input-message-id"] as string | undefined,
      modelId: ctx.values["model"] as string | undefined,
      thinkingLevel: ctx.values["thinking-level"] as string | undefined,
      systemPrompt: ctx.values["system-prompt"] as string | undefined,
    });

    if (ctx.values["json"]) {
      console.log(formatJson(run));
      return;
    }

    console.log(`Created run ${run["id"]}`);
  },
});
