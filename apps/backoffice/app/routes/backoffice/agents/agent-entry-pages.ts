import type { PiEntryPageReader } from "@fragno-private/backoffice-conversation/projection/transcript";
import { useCallback } from "react";

import type { PiManagerEntryPage } from "./data";

/**
 * Reads entry pages through an entries route, the agent's or a subagent's, which pages the
 * manager's entries.
 */
export function useEntryPageReader(pageUrl: string): PiEntryPageReader {
  return useCallback(
    async ({ minEntryId, maxEntryId, order, pageSize }) => {
      const query = new URLSearchParams({ order, pageSize: String(pageSize) });
      if (minEntryId !== null) {
        query.set("minEntryId", String(minEntryId));
      }
      if (maxEntryId !== null) {
        query.set("maxEntryId", String(maxEntryId));
      }
      const response = await fetch(`${pageUrl}?${query}`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`Pi history request failed with status ${response.status}.`);
      }
      // This application-owned resource route returns the manager's typed entry page unchanged.
      const page: PiManagerEntryPage = await response.json();
      return page;
    },
    [pageUrl],
  );
}
