import type { LofiSqliteReplica, LofiSqliteReplicaStatus } from "@fragno-dev/lofi/sqlite";
import { BackofficeDownloadState } from "@fragno-private/design-system/download-state";
import { useSyncExternalStore, type ReactNode } from "react";

export function useLofiSqliteReplicaStatus(replica: LofiSqliteReplica): LofiSqliteReplicaStatus {
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
  replica: LofiSqliteReplica;
  title: string;
  children: ReactNode;
}) {
  const status = useLofiSqliteReplicaStatus(replica);
  return status.phase === "caught-up" ? (
    children
  ) : (
    <BackofficeDownloadState title={title} fraction={status.fraction} error={status.error} />
  );
}
