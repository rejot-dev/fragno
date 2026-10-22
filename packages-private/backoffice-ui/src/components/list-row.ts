import { z } from "zod";

import { BACKOFFICE_UI_ICONS } from "./icon";
import { linkTargetSchema } from "./link";
import { backofficeUiToneSchema } from "./tone";

export const listRowDefinition = {
  props: z.strictObject({
    title: z.string().min(1).max(200),
    to: linkTargetSchema.optional(),
    detail: z.string().max(500).optional(),
    icon: z.enum(BACKOFFICE_UI_ICONS).optional(),
    tone: backofficeUiToneSchema.optional(),
  }),
  slots: ["default"],
  description:
    "One row of a rowList: an icon, its title, a muted detail line, and its children at the end, such as a relativeTime, badge, or sparkBars. With to, the whole row is a link, so its children hold no links. A tone puts the icon on a tile in that tone, for rows that ask for something.",
  example: {
    title: "nightly-sync",
    to: { kind: "run", workflowName: "nightly-sync", instanceId: "run-42" },
    detail: "2 errored runs",
    icon: "alert-triangle",
    tone: "failed",
  },
};
