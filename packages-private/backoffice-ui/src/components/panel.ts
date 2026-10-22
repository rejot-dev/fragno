import { z } from "zod";

import { linkTargetSchema } from "./link";

export const panelLinkSchema = z.strictObject({
  label: z.string().min(1).max(120),
  to: linkTargetSchema,
});

export const panelDefinition = {
  props: z.strictObject({
    title: z.string().min(1).max(80),
    link: panelLinkSchema.optional(),
  }),
  slots: ["default"],
  description:
    "A titled region of a page: its title over a rule, then its content, and optionally a closing link to where everything it summarizes lives. Pages are built of panels; put a rowList or content in each.",
  example: {
    title: "Connections",
    link: { label: "Show more on the Integrations page", to: { kind: "integrations" } },
  },
};
