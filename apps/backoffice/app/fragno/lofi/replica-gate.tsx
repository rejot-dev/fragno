import type { LofiSqliteClient, LofiSqliteReplicaStatus } from "@fragno-dev/lofi/sqlite";
import { Callout } from "@fragno-private/design-system/feedback/callout";
import { BackofficeDownloadState } from "@fragno-private/design-system/feedback/download-state";
import { useSyncExternalStore, type ReactNode } from "react";

/** A connection to a replica worker, which reports the replica's status. */
type LofiReplicaStatusSource = Pick<LofiSqliteClient, "getStatus" | "subscribeStatus">;

export function useLofiReplicaStatus(replica: LofiReplicaStatusSource): LofiSqliteReplicaStatus {
  return useSyncExternalStore(replica.subscribeStatus, replica.getStatus, replica.getStatus);
}

/**
 * Shows the replica's download until it holds everything its backend had when synchronization
 * started, then `children`, so views never present a partial history as the current state. While
 * synchronization fails after that, a notice says the view may be out of date; the replica retries
 * on its own, and the notice goes once a stream catches up again.
 */
export function LofiReplicaGate({
  replica,
  title,
  children,
}: {
  replica: LofiReplicaStatusSource;
  title: string;
  children: ReactNode;
}) {
  const status = useLofiReplicaStatus(replica);
  if (status.phase !== "caught-up") {
    return (
      <BackofficeDownloadState title={title} fraction={status.fraction} error={status.error} />
    );
  }
  return (
    <>
      {children}
      {status.error === null ? null : <LofiReplicaSyncNotice error={status.error} />}
    </>
  );
}

/** Floats over the view, since gated views are whole layouts that leave no room for a banner. */
function LofiReplicaSyncNotice({ error }: { error: string }) {
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 max-w-sm">
      <div className="pointer-events-auto bg-[var(--bo-panel)] shadow-lg">
        <Callout tone="failed" title="Live updates interrupted">
          <p>What you see may be out of date. Reconnecting…</p>
          <p className="mt-1 break-words text-[var(--bo-muted)]">{error}</p>
        </Callout>
      </div>
    </div>
  );
}
