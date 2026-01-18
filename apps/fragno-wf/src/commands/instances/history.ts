import { define } from "gunshi";
import { baseArgs, createClientFromContext } from "../../utils/options.js";
import { formatEventLine, formatLogLine, formatStepLine } from "../../utils/format.js";

export const instancesHistoryCommand = define({
  name: "history",
  description: "Show workflow instance history",
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
    run: {
      type: "number",
      description: "Run number (defaults to latest)",
    },
    "include-logs": {
      type: "boolean",
      description: "Include logs in the history output",
    },
    "log-level": {
      type: "string",
      description: "Filter logs by level (debug, info, warn, error)",
    },
    "log-category": {
      type: "string",
      description: "Filter logs by category",
    },
    order: {
      type: "string",
      description: "Sort order (asc or desc)",
    },
    "page-size": {
      type: "number",
      description: "Page size for pagination",
    },
    "steps-cursor": {
      type: "string",
      description: "Steps cursor for pagination",
    },
    "events-cursor": {
      type: "string",
      description: "Events cursor for pagination",
    },
    "logs-cursor": {
      type: "string",
      description: "Logs cursor for pagination",
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
    const response = await client.history({
      workflowName,
      instanceId,
      runNumber: ctx.values["run"] as number | undefined,
      includeLogs: ctx.values["include-logs"] as boolean | undefined,
      logLevel: ctx.values["log-level"] as string | undefined,
      logCategory: ctx.values["log-category"] as string | undefined,
      order: ctx.values["order"] as string | undefined,
      pageSize: ctx.values["page-size"] as number | undefined,
      stepsCursor: ctx.values["steps-cursor"] as string | undefined,
      eventsCursor: ctx.values["events-cursor"] as string | undefined,
      logsCursor: ctx.values["logs-cursor"] as string | undefined,
    });

    console.log(`Run number: ${response.runNumber}`);

    console.log("Steps:");
    if (!response.steps.length) {
      console.log("  (no steps)");
    } else {
      for (const step of response.steps) {
        console.log(`- ${formatStepLine(step)}`);
      }
    }

    console.log("Events:");
    if (!response.events.length) {
      console.log("  (no events)");
    } else {
      for (const event of response.events) {
        console.log(`- ${formatEventLine(event)}`);
      }
    }

    if (ctx.values["include-logs"]) {
      console.log("Logs:");
      const logs = response.logs ?? [];
      if (!logs.length) {
        console.log("  (no logs)");
      } else {
        for (const log of logs) {
          console.log(`- ${formatLogLine(log)}`);
        }
      }
    }

    if (response.stepsHasNextPage || response.eventsHasNextPage || response.logsHasNextPage) {
      console.log("");
    }
    if (response.stepsHasNextPage) {
      console.log(`Next steps cursor: ${response.stepsCursor ?? ""}`);
    }
    if (response.eventsHasNextPage) {
      console.log(`Next events cursor: ${response.eventsCursor ?? ""}`);
    }
    if (response.logsHasNextPage) {
      console.log(`Next logs cursor: ${response.logsCursor ?? ""}`);
    }
  },
});
