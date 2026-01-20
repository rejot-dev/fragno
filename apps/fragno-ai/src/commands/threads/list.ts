import { define } from "gunshi";
import { baseArgs, createClientFromContext } from "../../utils/options.js";
import { formatDate, formatJson, truncate } from "../../utils/format.js";

export const threadsListCommand = define({
  name: "list",
  description: "List threads",
  args: {
    ...baseArgs,
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
    const client = createClientFromContext(ctx);
    const response = await client.listThreads({
      pageSize: ctx.values["page-size"] as number | undefined,
      cursor: ctx.values["cursor"] as string | undefined,
      order: ctx.values["order"] as string | undefined,
    });

    if (ctx.values["json"]) {
      console.log(formatJson(response));
      return;
    }

    if (!response.threads.length) {
      console.log("No threads found.");
      return;
    }

    console.log("Threads:");
    for (const thread of response.threads) {
      const id = String(thread["id"] ?? "-");
      const title = thread["title"] ? truncate(String(thread["title"]), 60) : "(untitled)";
      const modelId = thread["defaultModelId"] ? ` model:${thread["defaultModelId"]}` : "";
      const updatedAt = thread["updatedAt"] ? ` updated:${formatDate(thread["updatedAt"])}` : "";
      console.log(`- ${id} ${title}${modelId}${updatedAt}`);
    }

    if (response.hasNextPage) {
      console.log("");
      console.log(`Next cursor: ${response.cursor ?? ""}`);
    }
  },
});
