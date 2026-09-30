import { BackofficeSystemState } from "./system-state";

export default { title: "Feedback/System state" };

export function Loading() {
  return <BackofficeSystemState tone="loading" title="Loading automations" />;
}

export function Empty() {
  return (
    <BackofficeSystemState
      tone="empty"
      title="No automations yet"
      description="Create a script to react to routes, schedules, or events."
    />
  );
}

export function ErrorWithAction() {
  return (
    <BackofficeSystemState
      tone="error"
      title="Could not reach the workspace"
      description="The durable object did not respond in time."
      actions={
        <button
          type="button"
          className="inline-flex min-h-10 items-center border border-[color:var(--bo-border)] px-4 text-xs font-semibold"
        >
          Retry
        </button>
      }
    />
  );
}

export function Flush() {
  return <BackofficeSystemState tone="empty" title="Nothing selected" flush />;
}
