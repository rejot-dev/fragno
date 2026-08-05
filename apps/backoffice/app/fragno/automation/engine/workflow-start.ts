import { BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY } from "@/fragno/automation/actors";

import { AUTOMATION_SYSTEM_INITIATOR } from "../actors";
import type { AutomationEvent, AutomationEventPayload } from "../contracts";
import { createAutomationRuntimeExecution } from "./runtime-execution";
import type { AutomationCodemodeWorkflowParams } from "./workflow";

export const AUTOMATION_CODEMODE_WORKFLOW = "automation-codemode-script";
export const PI_CODEMODE_WORKFLOW = "pi-codemode-script";

export const sanitizeWorkflowInstanceId = (value: string) =>
  value.replaceAll(/[^A-Za-z0-9_-]/g, "-");

export const createManualAutomationEvent = ({
  orgId,
  source,
  eventType,
  payload,
  id = sanitizeWorkflowInstanceId(`run-${orgId}-${crypto.randomUUID()}`),
}: {
  orgId: string;
  source: string;
  eventType: string;
  payload: AutomationEventPayload;
  id?: string;
}): AutomationEvent => ({
  id,
  scope: { kind: "org", orgId },
  source,
  eventType,
  occurredAt: new Date().toISOString(),
  payload,
  actors: {
    initiator: AUTOMATION_SYSTEM_INITIATOR,
    principal: null,
    delegation: [],
  },
  subject: { orgId },
});

export const createAutomationCodemodeWorkflowParams = ({
  event,
  workflowScriptPath,
  instanceId,
}: {
  event: AutomationEvent;
  workflowScriptPath: string;
  instanceId: string;
}): AutomationCodemodeWorkflowParams => {
  const execution = createAutomationRuntimeExecution(event);
  return {
    automationEvent: event,
    workflowScriptPath,
    workflowInstanceId: instanceId,
    idempotencyKey: instanceId,
    metadata: {
      [BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY]: execution.actors,
    },
  };
};

export const createAutomationCodemodeWorkflowInstanceInput = ({
  event,
  workflowScriptPath,
  instanceId,
  remoteWorkflowName,
}: {
  event: AutomationEvent;
  workflowScriptPath: string;
  instanceId: string;
  remoteWorkflowName?: string;
}) => ({
  workflowName: AUTOMATION_CODEMODE_WORKFLOW,
  remoteWorkflowName,
  instanceId,
  params: createAutomationCodemodeWorkflowParams({ event, workflowScriptPath, instanceId }),
});
