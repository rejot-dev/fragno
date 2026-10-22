import { z } from "zod";

const identifierSchema = z.string().min(1).max(200);

export const workflowResponseDefinition = {
  props: z.strictObject({ workflowName: identifierSchema, instanceId: identifierSchema }),
  slots: [],
  description:
    "The form a waiting run asks a person to answer, such as an upload or an approval; workflowName is the runner's internal name. It shows nothing while the run does not ask. Only pages show it; put it in a ui.listRow's expanded.",
  example: { workflowName: "expense-approval", instanceId: "run-42" },
};
