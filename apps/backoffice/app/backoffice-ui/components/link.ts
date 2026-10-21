import { z } from "zod";

const identifierSchema = z.string().min(1).max(200);

export const linkTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("run"),
    workflowName: identifierSchema,
    instanceId: identifierSchema,
  }),
  z.strictObject({ kind: z.literal("route"), id: identifierSchema }),
  z.strictObject({ kind: z.literal("connection"), id: identifierSchema }),
]);

/** What a link opens in the current scope: a workflow run, an automation route, or a connection. */
export type BackofficeUiLinkTarget = z.infer<typeof linkTargetSchema>;

export const linkDefinition = {
  props: z.strictObject({
    label: z.string().min(1).max(200),
    to: linkTargetSchema,
  }),
  slots: [],
  description:
    "Links to a workflow run (workflowName is the runner's internal name), an automation route, or an integration connection in the current scope.",
  example: {
    label: "Latest run",
    to: { kind: "run", workflowName: "ship-order", instanceId: "run-42" },
  },
};
