import { define } from "gunshi";
import { baseArgs, createClientFromContext } from "../../utils/options.js";
import { formatDate, formatJson, truncate } from "../../utils/format.js";

export const messagesListCommand = define({
  name: "list",
  description: "List messages for a thread",
  args: {
    ...baseArgs,
    thread: {
      type: "string",
      short: "t",
      description: "Thread ID",
    },
    "page-size": {
      type: "number",
      description: "Page size for pagination",
    },
    cursor: {
      type: "string",
      description: "Cursor for pagination",
    },
    order: {
      type: "string",
      description: "Order by createdAt (asc|desc)",
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
    const response = await client.listMessages({
      threadId,
      pageSize: ctx.values["page-size"] as number | undefined,
      cursor: ctx.values["cursor"] as string | undefined,
      order: ctx.values["order"] as string | undefined,
    });

    if (ctx.values["json"]) {
      console.log(formatJson(response));
      return;
    }

    if (!response.messages.length) {
      console.log("No messages found.");
      return;
    }

    console.log(`Messages for ${threadId}:`);
    for (const message of response.messages) {
      const id = String(message["id"] ?? "-");
      const role = String(message["role"] ?? "-");
      const textValue = message["text"]
        ? truncate(String(message["text"]), 80)
        : truncate(formatJson(message["content"]), 80);
      const createdAt = message["createdAt"] ? ` ${formatDate(message["createdAt"])}` : "";
      console.log(`- ${id} ${role}${createdAt} ${textValue}`);
    }

    if (response.hasNextPage) {
      console.log("");
      console.log(`Next cursor: ${response.cursor ?? ""}`);
    }
  },
});
