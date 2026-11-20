import { LoadingBar } from "./loading-bar";

export default { title: "Feedback/Loading bar" };

export function Default() {
  return (
    <div className="w-80">
      <LoadingBar label="Loading workflows" />
    </div>
  );
}

export function FullWidth() {
  return <LoadingBar label="Loading page" />;
}

export function InPanel() {
  return (
    <div className="w-96 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
      <p className="text-sm font-semibold">Connecting Slack</p>
      <p className="mt-1 text-xs text-[var(--bo-muted)]">Waiting for the provider to respond…</p>
      <div className="mt-4">
        <LoadingBar label="Connecting Slack" />
      </div>
    </div>
  );
}
