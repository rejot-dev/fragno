import { z } from "zod";

import { backofficeUiToneSchema } from "./tone";

export const badgeDefinition = {
  props: z.strictObject({
    label: z.string().min(1).max(80),
    tone: backofficeUiToneSchema,
  }),
  slots: [],
  description: "Displays a compact semantic status label.",
  example: { label: "Live", tone: "live" },
};
