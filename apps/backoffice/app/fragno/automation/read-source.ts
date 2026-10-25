import type { LofiSqliteClient } from "@fragno-dev/lofi/sqlite";

import type { AutomationCollections } from "./tanstack/collections";

/**
 * Where a view shared between pages reads the scope's Automations data: the lofi replica, on pages
 * that moved to it, or the TanStack collections, on pages that have not yet. Pages pass the source
 * they already hold, so none opens a second copy of the scope's history for a shared view.
 */
export type AutomationReadSource<TCollections = AutomationCollections> =
  | { kind: "replica"; replica: LofiSqliteClient }
  | { kind: "collections"; collections: TCollections };

/** The replica a source names, or null when it names the TanStack collections. */
export function automationReadReplica(
  source: AutomationReadSource<unknown> | undefined,
): LofiSqliteClient | null {
  return source?.kind === "replica" ? source.replica : null;
}

/** The TanStack collections a source names, or null when it names the replica. */
export function automationReadCollections<TCollections>(
  source: AutomationReadSource<TCollections> | undefined,
): TCollections | null {
  return source?.kind === "collections" ? source.collections : null;
}
