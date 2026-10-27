import {
  backofficeContextScopeSchema,
  backofficeContextScopesEqual,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import type { AutomationWorkflowRun } from "./workflow-run-presentation";

// Instance params are opaque to the workflow runtime; only Codemode runs carry a program.
const codemodeWorkflowRunParamsSchema = z.object({
  program: z.union([
    // Snapshots from before workflow modules store their source as one expression. They also
    // carry the modules it imports, so they are told apart by their code, not their modules.
    z.object({ filename: z.string(), code: z.string() }),
    z
      .object({ filename: z.string(), modules: z.record(z.string(), z.string()) })
      // A program's own module holds its source.
      .transform(({ filename, modules }) => ({ filename, code: modules[filename] ?? null })),
  ]),
  trigger: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("event"),
      event: z.object({ source: z.string(), eventType: z.string() }),
    }),
    z.object({ type: z.literal("manual") }),
  ]),
  execution: z.object({ scope: backofficeContextScopeSchema }),
  // Runs from before runs reported where they end carry no `replyTo`, and from before agents of
  // other scopes could start them, no agent scope.
  replyTo: z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("agent"),
        scope: backofficeContextScopeSchema.optional(),
        agentName: z.string(),
      }),
      z.object({ kind: z.literal("workflow") }),
    ])
    .nullish(),
});

/** The agent whose conversation started the run, when that conversation is in the run's scope. */
function startingAgentName({
  execution,
  replyTo,
}: z.infer<typeof codemodeWorkflowRunParamsSchema>) {
  if (replyTo?.kind !== "agent") {
    return null;
  }
  const local = !replyTo.scope || backofficeContextScopesEqual(replyTo.scope, execution.scope);
  return local ? replyTo.agentName : null;
}

export type WorkflowRunRecordSelector =
  | { type: "active-codemode" }
  | { type: "waiting" }
  | { type: "instance"; workflowName: string; instanceId: string };

type PersistedAutomationWorkflowRun = Omit<AutomationWorkflowRun, "codemode"> & {
  params: unknown;
};

/**
 * Casts synchronized rows to runs. The workflow schema stores statuses as strings, but the runner
 * only persists its own states.
 */
export function automationWorkflowRunsFromRecords(
  records: readonly unknown[],
): AutomationWorkflowRun[] {
  return (records as PersistedAutomationWorkflowRun[]).map(({ params, ...instance }) => {
    const codemodeParams = codemodeWorkflowRunParamsSchema.safeParse(params);
    const code = codemodeParams.success ? codemodeParams.data.program.code : null;
    return {
      ...instance,
      codemode:
        codemodeParams.success && code !== null
          ? {
              filename: codemodeParams.data.program.filename,
              code,
              trigger:
                codemodeParams.data.trigger.type === "event"
                  ? {
                      type: "event",
                      source: codemodeParams.data.trigger.event.source,
                      eventType: codemodeParams.data.trigger.event.eventType,
                    }
                  : { type: "manual" },
              agentName: startingAgentName(codemodeParams.data),
            }
          : null,
    };
  });
}
