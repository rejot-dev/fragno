import { define } from "gunshi";

import { formatJson } from "../../utils/format.js";
import { baseArgs, createClientFromContext, parseJsonValue } from "../../utils/options.js";

export const instancesCreateCommand = define({
  name: "create",
  description: "Create a workflow instance",
  args: {
    ...baseArgs,
    workflow: {
      type: "string",
      short: "w",
      description: "Workflow name",
    },
    id: {
      type: "string",
      short: "i",
      description: "Optional instance ID",
    },
    params: {
      type: "string",
      description: "JSON params payload",
    },
  },
  run: async (ctx) => {
    const workflowName = ctx.values.workflow;
    if (!workflowName) {
      throw new Error("Missing --workflow");
    }

    const params = parseJsonValue("params", ctx.values.params);
    const client = createClientFromContext(ctx);
    const response = await client.createInstance({
      workflowName,
      id: ctx.values.id,
      params,
    });

    console.log(`Created instance ${response.id}`);
    console.log(`Status: ${String(response.details["status"] ?? "unknown")}`);
    if (params !== undefined) {
      console.log("Params:");
      console.log(formatJson(params));
    }
  },
});
