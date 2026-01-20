import { define } from "gunshi";
import { baseArgs, createClientFromContext } from "../../utils/options.js";
import { formatDate, formatJson } from "../../utils/format.js";

export const threadsGetCommand = define({
  name: "get",
  description: "Get a thread",
  args: {
    ...baseArgs,
    thread: {
      type: "string",
      short: "t",
      description: "Thread ID",
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

    const client = createClientFromContext(ctx);
    const thread = await client.getThread({ threadId });

    if (ctx.values["json"]) {
      console.log(formatJson(thread));
      return;
    }

    console.log(`Thread ${threadId}`);
    console.log(`title: ${String(thread["title"] ?? "-")}`);
    console.log(`defaultModelId: ${String(thread["defaultModelId"] ?? "-")}`);
    console.log(`defaultThinkingLevel: ${String(thread["defaultThinkingLevel"] ?? "-")}`);
    console.log(`systemPrompt: ${String(thread["systemPrompt"] ?? "-")}`);
    console.log(`openaiToolConfig: ${formatJson(thread["openaiToolConfig"])}`);
    console.log(`metadata: ${formatJson(thread["metadata"])}`);
    console.log(`createdAt: ${formatDate(thread["createdAt"])}`);
    console.log(`updatedAt: ${formatDate(thread["updatedAt"])}`);
  },
});
