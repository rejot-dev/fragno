import { BackofficeSystemState } from "@fragno-private/design-system/system-state";

export default function BackofficeWorkflowsOrganizationIndex() {
  return (
    <BackofficeSystemState
      tone="empty"
      label="Workflow instance"
      title="Select an instance to inspect it."
      description="Its current step, state, and step, event, and emission history appear here."
    />
  );
}
