import { define } from "gunshi";
import { baseArgs, createClientFromContext } from "../../utils/options.js";
import { formatDate, formatJson } from "../../utils/format.js";

export const runsListCommand = define({
  name: "list",
  description: "List runs for a thread",
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
    const response = await client.listRuns({
      threadId,
      pageSize: ctx.values["page-size"] as number | undefined,
      cursor: ctx.values["cursor"] as string | undefined,
      order: ctx.values["order"] as string | undefined,
    });

    if (ctx.values["json"]) {
      console.log(formatJson(response));
      return;
    }

    if (!response.runs.length) {
      console.log("No runs found.");
      return;
    }

    console.log(`Runs for ${threadId}:`);
    for (const run of response.runs) {
      const id = String(run["id"] ?? "-");
      const status = String(run["status"] ?? "-");
      const type = String(run["type"] ?? "-");
      const mode = String(run["executionMode"] ?? "-");
      const modelId = run["modelId"] ? ` model:${run["modelId"]}` : "";
      const error = run["error"] ? ` error:${String(run["error"])}` : "";
      const updatedAt = run["updatedAt"] ? ` updated:${formatDate(run["updatedAt"])}` : "";
      console.log(`- ${id} ${status} ${type} ${mode}${modelId}${error}${updatedAt}`);
    }

    if (response.hasNextPage) {
      console.log("");
      console.log(`Next cursor: ${response.cursor ?? ""}`);
    }
  },
});
