import { BackofficeStatusLight } from "./status-light";

export default { title: "Feedback/Status light" };

export function Tones() {
  return (
    <div className="flex flex-wrap gap-4">
      <BackofficeStatusLight tone="info">Info</BackofficeStatusLight>
      <BackofficeStatusLight tone="live">Live</BackofficeStatusLight>
      <BackofficeStatusLight tone="waiting">Waiting</BackofficeStatusLight>
      <BackofficeStatusLight tone="failed">Failed</BackofficeStatusLight>
      <BackofficeStatusLight tone="muted">Muted</BackofficeStatusLight>
    </div>
  );
}
