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

export function WithoutDot() {
  return (
    <div className="flex flex-wrap gap-4">
      <BackofficeStatusLight tone="live" dot={false}>
        Ready
      </BackofficeStatusLight>
      <BackofficeStatusLight tone="waiting" dot={false}>
        Unavailable
      </BackofficeStatusLight>
    </div>
  );
}

export function Wrapping() {
  return (
    <div className="flex w-64 flex-col gap-4">
      <BackofficeStatusLight tone="waiting" dot={false} wrap>
        Waiting for all external provider synchronizations to finish before retrying
      </BackofficeStatusLight>
    </div>
  );
}
