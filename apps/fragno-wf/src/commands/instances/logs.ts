import { define } from "gunshi";
import { baseArgs, createClientFromContext } from "../../utils/options.js";
import { formatLogLine } from "../../utils/format.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const instancesLogsCommand = define({
  name: "logs",
  description: "Show workflow instance logs",
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
    follow: {
      type: "boolean",
      description: "Follow logs with polling",
    },
    "follow-interval": {
      type: "number",
      description: "Polling interval in ms when following (default: 2000)",
    },
    "page-size": {
      type: "number",
      description: "Page size for pagination",
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
    const follow = Boolean(ctx.values["follow"]);
    const followInterval = (ctx.values["follow-interval"] as number | undefined) ?? 2000;
    let logsCursor = ctx.values["logs-cursor"] as string | undefined;

    let stop = false;
    const stopHandler = () => {
      stop = true;
    };
    if (follow) {
      process.on("SIGINT", stopHandler);
      process.on("SIGTERM", stopHandler);
    }

    do {
      const response = await client.history({
        workflowName,
        instanceId,
        runNumber: ctx.values["run"] as number | undefined,
        includeLogs: true,
        logLevel: ctx.values["log-level"] as string | undefined,
        logCategory: ctx.values["log-category"] as string | undefined,
        order: ctx.values["order"] as string | undefined,
        pageSize: ctx.values["page-size"] as number | undefined,
        logsCursor,
      });

      const logs = response.logs ?? [];
      if (!logs.length && !follow) {
        console.log("No logs found.");
        return;
      }
      for (const log of logs) {
        console.log(`- ${formatLogLine(log)}`);
      }

      logsCursor = response.logsCursor;

      if (!follow) {
        if (response.logsHasNextPage) {
          console.log("");
          console.log(`Next logs cursor: ${response.logsCursor ?? ""}`);
        }
        return;
      }

      if (!response.logsHasNextPage) {
        await wait(followInterval);
      }
    } while (follow && !stop);
  },
});
