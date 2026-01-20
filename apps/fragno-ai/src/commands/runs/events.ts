import { define } from "gunshi";
import { baseArgs, createClientFromContext } from "../../utils/options.js";
import { formatDate, formatJson, truncate } from "../../utils/format.js";

export const runsEventsCommand = define({
  name: "events",
  description: "List run events",
  args: {
    ...baseArgs,
    run: {
      type: "string",
      short: "r",
      description: "Run ID",
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
    const runId = ctx.values["run"] as string | undefined;
    if (!runId) {
      throw new Error("Missing --run");
    }

    const client = createClientFromContext(ctx);
    const response = await client.listRunEvents({
      runId,
      pageSize: ctx.values["page-size"] as number | undefined,
      cursor: ctx.values["cursor"] as string | undefined,
      order: ctx.values["order"] as string | undefined,
    });

    if (ctx.values["json"]) {
      console.log(formatJson(response));
      return;
    }

    if (!response.events.length) {
      console.log("No events found.");
      return;
    }

    console.log(`Events for ${runId}:`);
    for (const event of response.events) {
      const seq = String(event["seq"] ?? "-");
      const type = String(event["type"] ?? "-");
      const createdAt = event["createdAt"] ? formatDate(event["createdAt"]) : "-";
      const payload = event["payload"] ? truncate(formatJson(event["payload"]), 120) : "-";
      console.log(`- ${seq} ${type} ${createdAt} ${payload}`);
    }

    if (response.hasNextPage) {
      console.log("");
      console.log(`Next cursor: ${response.cursor ?? ""}`);
    }
  },
});
