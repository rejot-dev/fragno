import { define } from "gunshi";
import { baseArgs, createClientFromContext } from "../../utils/options.js";

export const instancesListCommand = define({
  name: "list",
  description: "List workflow instances",
  args: {
    ...baseArgs,
    workflow: {
      type: "string",
      short: "w",
      description: "Workflow name",
    },
    status: {
      type: "string",
      description:
        "Filter by status (queued, running, waiting, paused, complete, terminated, errored)",
    },
    "page-size": {
      type: "number",
      description: "Page size for pagination",
    },
    cursor: {
      type: "string",
      description: "Cursor for pagination",
    },
  },
  run: async (ctx) => {
    const workflowName = ctx.values["workflow"] as string | undefined;
    if (!workflowName) {
      throw new Error("Missing --workflow");
    }

    const client = createClientFromContext(ctx);
    const response = await client.listInstances({
      workflowName,
      status: ctx.values["status"] as string | undefined,
      pageSize: ctx.values["page-size"] as number | undefined,
      cursor: ctx.values["cursor"] as string | undefined,
    });

    if (!response.instances.length) {
      console.log("No instances found.");
      return;
    }

    console.log(`Instances for ${workflowName}:`);
    for (const instance of response.instances) {
      const status = instance.details["status"] ? String(instance.details["status"]) : "unknown";
      const error = instance.details["error"]
        ? ` (${String((instance.details["error"] as { name?: string }).name ?? "Error")})`
        : "";
      console.log(`- ${instance.id} ${status}${error}`);
    }

    if (response.hasNextPage) {
      console.log("");
      console.log(`Next cursor: ${response.cursor ?? ""}`);
    }
  },
});
