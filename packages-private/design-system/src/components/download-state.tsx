import { Spinner } from "./spinner";

/**
 * A download of data into this browser that a view waits for, such as a local replica catching
 * up with its server. `fraction` is null until the size of the download is known; `error` is the
 * failure of the last attempt while the download retries.
 */
export function BackofficeDownloadState({
  title,
  fraction,
  error,
}: {
  title: string;
  /** Between 0 and 1. */
  fraction: number | null;
  error: string | null;
}) {
  // The percentage goes last, so only it changes while the download runs.
  const description =
    error !== null
      ? `Synchronization failed and is retrying: ${error}`
      : fraction === null
        ? "Getting things ready…"
        : `Getting things ready… ${Math.floor(Math.min(1, Math.max(0, fraction)) * 100)}%`;

  // A pane spinner, as other loading panes show, with the progress spelled out beneath it.
  return (
    <div role="status" className="flex min-h-24 flex-1 items-center justify-center px-4">
      <div className="flex max-w-md flex-col items-center gap-2 text-center">
        <Spinner />
        <p className="text-sm font-semibold text-balance text-[var(--bo-fg)]">{title}</p>
        <p className="text-sm text-pretty text-[var(--bo-muted)] tabular-nums">{description}</p>
      </div>
    </div>
  );
}
