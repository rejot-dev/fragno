import { define } from "gunshi";
import { baseArgs, createClientFromContext } from "../../utils/options.js";

type ManageAction = "pause" | "resume" | "restart" | "terminate";

export const createManageCommand = (action: ManageAction, description: string) =>
  define({
    name: action,
    description,
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
      await client.manageInstance({ workflowName, instanceId, action });
      console.log(`Instance ${instanceId} ${action}d.`);
    },
  });
