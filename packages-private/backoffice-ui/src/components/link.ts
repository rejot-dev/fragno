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
  z.strictObject({ kind: z.literal("integrations") }),
  z.strictObject({ kind: z.literal("agents") }),
]);

/**
 * What a link opens in the current scope: a workflow run, an automation route, a connection, or
 * the scope's integrations or agents.
 */
export type BackofficeUiLinkTarget = z.infer<typeof linkTargetSchema>;

export const linkDefinition = {
  props: z.strictObject({
    label: z.string().min(1).max(200),
    to: linkTargetSchema,
  }),
  slots: [],
  description:
    "Links to a workflow run (workflowName is the runner's internal name), an automation route, an integration connection, or the integrations or agents of the current scope.",
  example: {
    label: "Latest run",
    to: { kind: "run", workflowName: "ship-order", instanceId: "run-42" },
  },
};
