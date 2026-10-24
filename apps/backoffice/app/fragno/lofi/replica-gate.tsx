import type { LofiSqliteReplica, LofiSqliteReplicaStatus } from "@fragno-dev/lofi/sqlite";
import { BackofficeDownloadState } from "@fragno-private/design-system/download-state";
import { useSyncExternalStore, type ReactNode } from "react";

/** A replica on the page or a connection to one in a worker: both report the replica's status. */
type LofiReplicaStatusSource = Pick<LofiSqliteReplica, "getStatus" | "subscribeStatus">;

export function useLofiReplicaStatus(replica: LofiReplicaStatusSource): LofiSqliteReplicaStatus {
  return useSyncExternalStore(replica.subscribeStatus, replica.getStatus, replica.getStatus);
}

/**
 * Shows the replica's download until it holds everything its backend had when synchronization
 * started, then `children`, so views never present a partial history as the current state.
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
  return status.phase === "caught-up" ? (
    children
  ) : (
    <BackofficeDownloadState title={title} fraction={status.fraction} error={status.error} />
  );
}
