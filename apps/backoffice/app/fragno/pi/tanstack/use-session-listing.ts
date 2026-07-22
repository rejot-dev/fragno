import { use } from "react";

import { eq, useLiveQuery } from "@tanstack/react-db";

import { getPiTanStackDatabase, type PiPersistenceSource } from "./database";
import {
  projectPiSessionListingRows,
  resolvePiSessionListingState,
  type PiSessionListingSnapshot,
} from "./session-listing";

export function usePiSessionListing({
  source,
  workflowName,
  limit = 50,
}: {
  source: PiPersistenceSource;
  workflowName: string;
  limit?: number;
}) {
  const database = use(getPiTanStackDatabase());
  const collections = database.collectionsFor(source);
  const listingQuery = useLiveQuery(
    (query) =>
      query
        .from({ session: collections.sessions })
        .leftJoin({ workflow: collections.workflowInstances }, ({ session, workflow }) =>
          eq(session.id, workflow.id),
        )
        .where(({ session }) => eq(session.workflowName, workflowName))
        .orderBy(({ session }) => session.createdAt, "desc")
        .orderBy(({ session }) => session.id, "desc")
        .limit(limit)
        .select(({ session, workflow }) => ({
          sessionId: session.sessionId,
          name: session.name,
          agent: session.agent,
          workflowName: session.workflowName,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          workflowStatus: workflow?.status,
        })),
    [collections.sessions, collections.workflowInstances, limit, workflowName],
  );
  const snapshot: PiSessionListingSnapshot = projectPiSessionListingRows(listingQuery.data ?? []);
  const sourceError = listingQuery.isError
    ? (collections.sessions.utils.getLastError() ??
      collections.workflowInstances.utils.getLastError())
    : undefined;
  const persistenceError =
    sourceError instanceof Error
      ? sourceError.message
      : listingQuery.isError
        ? "Pi session listing synchronization failed."
        : null;

  return resolvePiSessionListingState({
    snapshot,
    synchronized: listingQuery.isReady,
    error: persistenceError,
  });
}
