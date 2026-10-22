import { z } from "zod";

import { backofficeUiToneSchema } from "./tone";

/** The icons an interface marks rows with; a short list keeps the catalog readable. */
export const BACKOFFICE_UI_ICONS = [
  "activity",
  "alert-circle",
  "alert-triangle",
  "bell",
  "calendar",
  "check",
  "check-circle",
  "clock",
  "edit-3",
  "inbox",
  "info",
  "link",
  "mail",
  "message-square",
  "pause-circle",
  "play-circle",
  "user",
  "users",
  "x-circle",
  "zap",
] as const;

export const iconDefinition = {
  props: z.strictObject({
    name: z.enum(BACKOFFICE_UI_ICONS),
    tone: backofficeUiToneSchema.optional(),
  }),
  slots: [],
  description:
    "Displays a small icon that marks a row's kind, such as alert-triangle for a failure, in a status tone; muted without one.",
  example: { name: "alert-triangle", tone: "failed" },
};
