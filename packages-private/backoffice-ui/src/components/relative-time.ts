import { z } from "zod";

export const relativeTimeDefinition = {
  props: z.strictObject({
    time: z.iso.datetime().nullable(),
  }),
  slots: [],
  description:
    "Displays how long ago or until an ISO 8601 time, such as 3m ago or in 2h, and keeps it current; null shows a dash.",
  example: { time: "2026-10-21T10:00:00.000Z" },
};
