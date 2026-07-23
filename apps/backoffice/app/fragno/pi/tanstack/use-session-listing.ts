import { use } from "react";

import { useLiveQuery } from "@tanstack/react-db";

import { getPiBrowserDatabase, type PiCollectionSource } from "./browser-database";
import {
  buildPiSessionListingQuery,
  projectPiSessionListingRows,
  resolvePiSessionListingState,
  type PiSessionListingSnapshot,
} from "./session-listing";

export function usePiSessionListing({
  source,
  workflowName,
  limit = 50,
}: {
  source: PiCollectionSource;
  workflowName: string;
  limit?: number;
}) {
  const database = use(getPiBrowserDatabase());
  const collections = database.collectionsFor(source);
  const listingQuery = useLiveQuery(
    (query) => buildPiSessionListingQuery(query, { collections, workflowName, limit }),
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
