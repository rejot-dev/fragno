import { BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY } from "@/fragno/automation/actors";

import type { AutomationTriggerBinding } from "../../runtime-tools/automation-types";
import type { BackofficeWorkflowActorMetadata } from "../actors";
import type { AutomationEvent } from "../contracts";
import { createAutomationRuntimeExecution } from "./runtime-execution";

export const AUTOMATION_CODEMODE_WORKFLOW = "automation-codemode-script";

export type AutomationCodemodeWorkflowParams = {
  automationEvent: AutomationEvent;
  workflowInstanceId: string;
  binding?: AutomationTriggerBinding;
  idempotencyKey?: string;
  metadata: BackofficeWorkflowActorMetadata;
  script: { kind: "file"; path: string };
};

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
    script: { kind: "file", path: workflowScriptPath },
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
