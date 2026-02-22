import { define } from "gunshi";
import { baseArgs, createClientFromContext } from "../../utils/options.js";
import { formatDate, formatJson } from "../../utils/format.js";

export const instancesGetCommand = define({
  name: "get",
  description: "Get instance details",
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
    full: {
      type: "boolean",
      description: "Include params and output payloads",
    },
  },
  run: async (ctx) => {
    const workflowName = ctx.values["workflow"] as string | undefined;
    const instanceId = ctx.values["id"] as string | undefined;

    if (!workflowName) {
      throw new Error("Missing --workflow");
    }
    if (!instanceId) {
      throw new Error("Missing --id");
    }

    const client = createClientFromContext(ctx);
    const response = await client.getInstance({ workflowName, instanceId });
    const details = response.details;
    const meta = response.meta;

    console.log(`Instance ${response.id}`);
    console.log(`Status: ${String(details["status"] ?? "unknown")}`);

    if (details["error"]) {
      const name = String((details["error"] as { name?: string }).name ?? "Error");
      const message = String((details["error"] as { message?: string }).message ?? "");
      console.log(`Error: ${name}${message ? ` - ${message}` : ""}`);
    }

    console.log(`Workflow: ${String(meta["workflowName"] ?? workflowName)}`);
    console.log(`Run number: ${String(meta["runNumber"] ?? "-")}`);
    console.log(`Created at: ${formatDate(meta["createdAt"])}`);
    console.log(`Updated at: ${formatDate(meta["updatedAt"])}`);
    console.log(`Started at: ${formatDate(meta["startedAt"])}`);
    console.log(`Completed at: ${formatDate(meta["completedAt"])}`);

    if (meta["currentStep"]) {
      const current = meta["currentStep"] as Record<string, unknown>;
      console.log("Current step:");
      console.log(`  Key: ${String(current["stepKey"] ?? "-")}`);
      console.log(`  Name: ${String(current["name"] ?? "-")}`);
      console.log(`  Type: ${String(current["type"] ?? "-")}`);
      console.log(`  Status: ${String(current["status"] ?? "-")}`);
      console.log(
        `  Attempts: ${String(current["attempts"] ?? "-")}/${String(current["maxAttempts"] ?? "-")}`,
      );
      console.log(`  Timeout: ${String(current["timeoutMs"] ?? "-")}`);
      console.log(`  Next retry: ${formatDate(current["nextRetryAt"])}`);
      console.log(`  Wake at: ${formatDate(current["wakeAt"])}`);
      console.log(`  Waiting for: ${String(current["waitEventType"] ?? "-")}`);
    }

    if (ctx.values["full"]) {
      console.log("Params:");
      console.log(formatJson(meta["params"]));
      console.log("Output:");
      console.log(formatJson(details["output"]));
    }
  },
});
