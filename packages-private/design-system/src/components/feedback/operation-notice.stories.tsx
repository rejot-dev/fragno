import { InlineAlert } from "./inline-alert";
import { OperationNotice } from "./operation-notice";
import { WorkingIndicator } from "./working-indicator";

export default { title: "Feedback/Operation notice" };

export function Tones() {
  return (
    <div className="flex max-w-3xl flex-col gap-3">
      <OperationNotice
        tone="progress"
        title="Compacting context"
        description="Selecting history and writing a durable summary…"
      />
      <OperationNotice
        tone="neutral"
        title="Context was not compacted"
        description="Pi context did not need compaction."
      />
      <OperationNotice
        tone="failed"
        title="Context compaction failed"
        description="The summary model did not respond."
        onRetry={() => undefined}
      />
    </div>
  );
}

export function InlineStates() {
  return (
    <div className="flex max-w-3xl flex-col items-start gap-3">
      <WorkingIndicator>Synchronizing workflow…</WorkingIndicator>
      <InlineAlert>Write a message before sending.</InlineAlert>
    </div>
  );
}
