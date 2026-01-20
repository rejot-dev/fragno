import { define } from "gunshi";
import { baseArgs, createClientFromContext } from "../../utils/options.js";
import { formatJson } from "../../utils/format.js";

export const threadsDeleteCommand = define({
  name: "delete",
  description: "Delete a thread (admin route)",
  args: {
    ...baseArgs,
    thread: {
      type: "string",
      short: "t",
      description: "Thread ID",
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
    const result = await client.deleteThread({ threadId });

    if (ctx.values["json"]) {
      console.log(formatJson(result));
      return;
    }

    if (result.ok) {
      console.log(`Deleted thread ${threadId}`);
    } else {
      console.log(`Failed to delete thread ${threadId}`);
    }
  },
});
