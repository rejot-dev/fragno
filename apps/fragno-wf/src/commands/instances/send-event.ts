import { define } from "gunshi";

import { formatJson } from "../../utils/format.js";
import { baseArgs, createClientFromContext, parseJsonValue } from "../../utils/options.js";

export const instancesSendEventCommand = define({
  name: "send-event",
  description: "Send an event to a workflow instance",
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
      description: "Instance ID",
    },
    type: {
      type: "string",
      short: "t",
      description: "Event type",
    },
    payload: {
      type: "string",
      description: "JSON payload for the event",
    },
  },
  run: async (ctx) => {
    const workflowName = ctx.values.workflow;
    const instanceId = ctx.values.id;
    const type = ctx.values.type;

    if (!workflowName) {
      throw new Error("Missing --workflow");
    }
    if (!instanceId) {
      throw new Error("Missing --id");
    }
    if (!type) {
      throw new Error("Missing --type");
    }

    const payload = parseJsonValue("payload", ctx.values.payload);
    const client = createClientFromContext(ctx);
    const response = await client.sendEvent({
      workflowName,
      instanceId,
      type,
      payload,
    });

    console.log(`Event sent to ${instanceId} (${type})`);
    console.log(`Status: ${String(response.status["status"] ?? "unknown")}`);
    if (payload !== undefined) {
      console.log("Payload:");
      console.log(formatJson(payload));
    }
  },
});
