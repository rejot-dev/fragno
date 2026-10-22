import { z } from "zod";

import { linkTargetSchema } from "./link";

export const panelTableRowDefinition = {
  props: z.strictObject({
    title: z.string().min(1).max(200),
    to: linkTargetSchema.optional(),
  }),
  slots: ["default"],
  description:
    "One row of a panelTable: its title, linked when to is set, then one child per column, such as sparkBars, a number, or a row of a badge and a relativeTime.",
  example: {
    title: "nightly-sync",
    to: { kind: "run", workflowName: "nightly-sync", instanceId: "run-42" },
  },
};
