import { BackofficeSystemState } from "@fragno-private/design-system/system-state";

export default function BackofficeCodemodeRunsIndex() {
  return (
    <BackofficeSystemState
      tone="empty"
      label="Codemode run"
      title="Select a run to inspect it."
      description="Its logs and tool calls, with their input and output, appear here."
    />
  );
}
