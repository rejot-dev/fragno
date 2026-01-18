import { define } from "gunshi";
import { baseArgs, createClientFromContext } from "../../utils/options.js";

export const workflowsListCommand = define({
  name: "list",
  description: "List workflows registered by the fragment",
  args: {
    ...baseArgs,
  },
  run: async (ctx) => {
    const client = createClientFromContext(ctx);
    const response = await client.listWorkflows();

    if (!response.workflows.length) {
      console.log("No workflows found.");
      return;
    }

    console.log("Workflows:");
    for (const workflow of response.workflows) {
      console.log(`- ${workflow.name}`);
    }
  },
});
