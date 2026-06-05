import type { WorkflowRegistryEntry, WorkflowStepWorkflowOperation } from "./workflow";

export type WorkflowOperationRegistry = ReadonlyMap<string, Pick<WorkflowRegistryEntry, "remote">>;

export function validateAndNormalizeWorkflowOperation(
  workflowsByName: WorkflowOperationRegistry,
  operation: WorkflowStepWorkflowOperation,
): WorkflowStepWorkflowOperation {
  if (operation.type !== "createInstance") {
    throw new Error("WORKFLOW_STEP_WORKFLOW_OPERATION_UNSUPPORTED");
  }

  const workflow = workflowsByName.get(operation.workflowName);
  if (!workflow) {
    throw new Error("WORKFLOW_NOT_FOUND");
  }
  if (workflow.remote === true && !operation.remoteWorkflowName) {
    throw new Error("WORKFLOW_REMOTE_NAME_REQUIRED");
  }
  if (operation.remoteWorkflowName && workflow.remote !== true) {
    throw new Error("WORKFLOW_REMOTE_HOST_INVALID");
  }
  if (!operation.instanceId) {
    throw new Error("WORKFLOW_INSTANCE_ID_REQUIRED");
  }

  return {
    type: "createInstance",
    workflowName: operation.workflowName,
    instanceId: operation.instanceId,
    params: operation.params ?? {},
    remoteWorkflowName: operation.remoteWorkflowName ?? null,
  };
}
