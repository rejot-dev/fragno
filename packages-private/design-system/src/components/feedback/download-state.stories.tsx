import { BackofficeDownloadState } from "./download-state";

export default { title: "Feedback/Download state" };

export function Connecting() {
  return (
    <BackofficeDownloadState title="Downloading workspace files…" fraction={null} error={null} />
  );
}

export function Downloading() {
  return (
    <BackofficeDownloadState title="Downloading workspace files…" fraction={0.42} error={null} />
  );
}

export function Retrying() {
  return (
    <BackofficeDownloadState
      title="Downloading workspace files…"
      fraction={0.42}
      error="Outbox stream request failed: 503"
    />
  );
}
