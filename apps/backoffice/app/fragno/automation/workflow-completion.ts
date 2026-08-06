import { z } from "zod";

export const WORKFLOW_COMPLETED_EVENT_TYPE = "workflow.completed";
export const WORKFLOW_COMPLETION_PARAM = "__workflowCompletion";

const workflowCompletionTargetSchema = z.object({
  workflowName: z.string().min(1),
  instanceId: z.string().min(1),
});

export type WorkflowCompletionTarget = z.infer<typeof workflowCompletionTargetSchema>;

export type WorkflowCompletedEventPayload = {
  workflowName: string;
  instanceId: string;
  status: "complete" | "errored" | "terminated";
  output?: unknown;
  error?: { name: string; message: string };
};

export const withWorkflowCompletionTarget = <TParams extends Record<string, unknown>>(
  params: TParams,
  target: WorkflowCompletionTarget,
): TParams & { [WORKFLOW_COMPLETION_PARAM]: WorkflowCompletionTarget } => ({
  ...params,
  [WORKFLOW_COMPLETION_PARAM]: target,
});

export const parseWorkflowCompletionTarget = (params: unknown): WorkflowCompletionTarget | null => {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return null;
  }

  const workflowParams = params as Record<string, unknown>;
  if (!Object.hasOwn(workflowParams, WORKFLOW_COMPLETION_PARAM)) {
    return null;
  }

  const parsed = workflowCompletionTargetSchema.safeParse(
    workflowParams[WORKFLOW_COMPLETION_PARAM],
  );
  return parsed.success ? parsed.data : null;
};
