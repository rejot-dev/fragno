import { z } from "zod";

export const orchestrationDefinition = {
  props: z.strictObject({}),
  slots: [],
  description:
    "The scope's orchestration graph, as the dashboard shows it: every event source, event, route, and workflow, with the selected item's details beside it. Only pages show it; put it in a ui.panel.",
  example: {},
};
