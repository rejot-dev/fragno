import { BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY } from "@/fragno/automation/actors";

import type { AutomationTriggerBinding } from "../../runtime-tools/automation-types";
import type { BackofficeWorkflowActorMetadata } from "../actors";
import { createAutomationRuntimeExecution, type AutomationRuntimeAuthority } from "../authority";
import type { AutomationEvent } from "../contracts";

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
  authority,
  workflowScriptPath,
  instanceId,
}: {
  event: AutomationEvent;
  authority: AutomationRuntimeAuthority;
  workflowScriptPath: string;
  instanceId: string;
}): AutomationCodemodeWorkflowParams => {
  const execution = createAutomationRuntimeExecution({ event, authority });
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
  authority,
  workflowScriptPath,
  instanceId,
  remoteWorkflowName,
}: {
  event: AutomationEvent;
  authority: AutomationRuntimeAuthority;
  workflowScriptPath: string;
  instanceId: string;
  remoteWorkflowName?: string;
}) => ({
  workflowName: AUTOMATION_CODEMODE_WORKFLOW,
  remoteWorkflowName,
  instanceId,
  params: createAutomationCodemodeWorkflowParams({
    event,
    authority,
    workflowScriptPath,
    instanceId,
  }),
});
