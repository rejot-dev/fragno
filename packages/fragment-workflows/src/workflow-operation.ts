import type { WorkflowRegistryEntry, WorkflowStepWorkflowOperation } from "./workflow";

export type WorkflowOperationRegistry = ReadonlyMap<string, Pick<WorkflowRegistryEntry, "remote">>;

type CreateWorkflowInstanceOperation = Extract<
  WorkflowStepWorkflowOperation,
  { type: "createInstance" }
>;
type CreateWorkflowEventOperation = Extract<WorkflowStepWorkflowOperation, { type: "createEvent" }>;

export function validateAndNormalizeWorkflowOperation(
  workflowsByName: WorkflowOperationRegistry,
  operation: CreateWorkflowInstanceOperation,
): CreateWorkflowInstanceOperation;
export function validateAndNormalizeWorkflowOperation(
  workflowsByName: WorkflowOperationRegistry,
  operation: CreateWorkflowEventOperation,
): CreateWorkflowEventOperation;
export function validateAndNormalizeWorkflowOperation(
  workflowsByName: WorkflowOperationRegistry,
  operation: WorkflowStepWorkflowOperation,
): WorkflowStepWorkflowOperation;
export function validateAndNormalizeWorkflowOperation(
  workflowsByName: WorkflowOperationRegistry,
  operation: WorkflowStepWorkflowOperation,
): WorkflowStepWorkflowOperation {
  const operationType: unknown = (operation as { type?: unknown }).type;
  if (operationType !== "createInstance" && operationType !== "createEvent") {
    throw new Error("WORKFLOW_STEP_WORKFLOW_OPERATION_UNSUPPORTED");
  }

  const workflow = workflowsByName.get(operation.workflowName);
  if (!workflow) {
    throw new Error("WORKFLOW_NOT_FOUND");
  }
  if (!operation.instanceId) {
    throw new Error("WORKFLOW_INSTANCE_ID_REQUIRED");
  }

  if (operation.type === "createEvent") {
    if (!operation.eventId) {
      throw new Error("WORKFLOW_EVENT_ID_REQUIRED");
    }
    if (!operation.eventType) {
      throw new Error("WORKFLOW_EVENT_TYPE_REQUIRED");
    }
    if (workflow.remote === true) {
      throw new Error("WORKFLOW_EVENT_REMOTE_TARGET_UNSUPPORTED");
    }

    return {
      type: "createEvent",
      workflowName: operation.workflowName,
      instanceId: operation.instanceId,
      eventId: operation.eventId,
      eventType: operation.eventType,
      payload: operation.payload ?? null,
    };
  }

  if (workflow.remote === true && !operation.remoteWorkflowName) {
    throw new Error("WORKFLOW_REMOTE_NAME_REQUIRED");
  }
  if (operation.remoteWorkflowName && workflow.remote !== true) {
    throw new Error("WORKFLOW_REMOTE_HOST_INVALID");
  }

  return {
    type: "createInstance",
    workflowName: operation.workflowName,
    instanceId: operation.instanceId,
    params: operation.params ?? {},
    remoteWorkflowName: operation.remoteWorkflowName ?? null,
  };
}
