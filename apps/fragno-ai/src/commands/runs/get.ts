import { define } from "gunshi";
import { baseArgs, createClientFromContext } from "../../utils/options.js";
import { formatDate, formatJson } from "../../utils/format.js";

export const runsGetCommand = define({
  name: "get",
  description: "Get run details",
  args: {
    ...baseArgs,
    run: {
      type: "string",
      short: "r",
      description: "Run ID",
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
    const run = await client.getRun({ runId });

    if (ctx.values["json"]) {
      console.log(formatJson(run));
      return;
    }

    console.log(`Run ${runId}`);
    console.log(`threadId: ${String(run["threadId"] ?? "-")}`);
    console.log(`type: ${String(run["type"] ?? "-")}`);
    console.log(`executionMode: ${String(run["executionMode"] ?? "-")}`);
    console.log(`status: ${String(run["status"] ?? "-")}`);
    console.log(`modelId: ${String(run["modelId"] ?? "-")}`);
    console.log(`thinkingLevel: ${String(run["thinkingLevel"] ?? "-")}`);
    console.log(`systemPrompt: ${String(run["systemPrompt"] ?? "-")}`);
    console.log(`inputMessageId: ${String(run["inputMessageId"] ?? "-")}`);
    console.log(`openaiResponseId: ${String(run["openaiResponseId"] ?? "-")}`);
    console.log(`error: ${String(run["error"] ?? "-")}`);
    console.log(`attempt: ${String(run["attempt"] ?? "-")}`);
    console.log(`maxAttempts: ${String(run["maxAttempts"] ?? "-")}`);
    console.log(`nextAttemptAt: ${formatDate(run["nextAttemptAt"])}`);
    console.log(`createdAt: ${formatDate(run["createdAt"])}`);
    console.log(`updatedAt: ${formatDate(run["updatedAt"])}`);
    console.log(`startedAt: ${formatDate(run["startedAt"])}`);
    console.log(`completedAt: ${formatDate(run["completedAt"])}`);
  },
});
