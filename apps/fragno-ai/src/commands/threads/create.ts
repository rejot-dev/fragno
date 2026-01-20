import { define } from "gunshi";
import { baseArgs, createClientFromContext, parseJsonValue } from "../../utils/options.js";
import { formatJson } from "../../utils/format.js";

export const threadsCreateCommand = define({
  name: "create",
  description: "Create a thread",
  args: {
    ...baseArgs,
    title: {
      type: "string",
      description: "Thread title",
    },
    "system-prompt": {
      type: "string",
      description: "System prompt",
    },
    model: {
      type: "string",
      description: "Default model id",
    },
    "thinking-level": {
      type: "string",
      description: "Default thinking level",
    },
    "openai-tool-config": {
      type: "string",
      description: "OpenAI tool config JSON",
    },
    metadata: {
      type: "string",
      description: "Metadata JSON",
    },
    json: {
      type: "boolean",
      description: "Output JSON",
    },
  },
  run: async (ctx) => {
    const client = createClientFromContext(ctx);
    const thread = await client.createThread({
      title: (ctx.values["title"] as string | undefined) ?? null,
      systemPrompt: (ctx.values["system-prompt"] as string | undefined) ?? null,
      defaultModelId: ctx.values["model"] as string | undefined,
      defaultThinkingLevel: ctx.values["thinking-level"] as string | undefined,
      openaiToolConfig: parseJsonValue(
        "openai-tool-config",
        ctx.values["openai-tool-config"] as string | undefined,
      ),
      metadata: parseJsonValue("metadata", ctx.values["metadata"] as string | undefined),
    });

    if (ctx.values["json"]) {
      console.log(formatJson(thread));
      return;
    }

    console.log(`Created thread ${thread["id"]}`);
  },
});
