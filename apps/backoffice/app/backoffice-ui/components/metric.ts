import { z } from "zod";

export const metricDefinition = {
  props: z.strictObject({
    label: z.string(),
    value: z.string(),
  }),
  slots: [],
  description: "Displays one labeled operational metric.",
  example: { label: "Orders", value: "24" },
};
