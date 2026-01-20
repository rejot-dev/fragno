import { define } from "gunshi";
import { baseArgs, createClientFromContext } from "../../utils/options.js";
import { formatJson } from "../../utils/format.js";

export const runsCancelCommand = define({
  name: "cancel",
  description: "Cancel a run",
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
    const result = await client.cancelRun({ runId });

    if (ctx.values["json"]) {
      console.log(formatJson(result));
      return;
    }

    console.log(`Cancelled run ${runId}`);
  },
});
