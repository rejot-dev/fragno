import { use } from "react";

import { useLiveQuery } from "@tanstack/react-db";

import {
  getAutomationBrowserDatabase,
  type AutomationCollectionSource,
} from "@/fragno/automation/tanstack/browser-database";

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
  source: AutomationCollectionSource;
  workflowName: string;
  limit?: number;
}) {
  const { collections } = use(getAutomationBrowserDatabase(source));
  const listingQuery = useLiveQuery(
    (query) => buildPiSessionListingQuery(query, { collections, workflowName, limit }),
    [collections.workflowInstances, limit, workflowName],
  );
  const snapshot: PiSessionListingSnapshot = projectPiSessionListingRows(listingQuery.data ?? []);
  const persistenceError = listingQuery.isError
    ? "Pi session listing synchronization failed."
    : null;

  return resolvePiSessionListingState({
    snapshot,
    synchronized: listingQuery.isReady,
    error: persistenceError,
  });
}
