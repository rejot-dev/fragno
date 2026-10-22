import { createCollection, type Collection } from "@tanstack/react-db";

/**
 * A read-only collection of rows derived from another collection's rows in TypeScript, for rules a
 * query cannot express, such as which connection state change is current. The source is usually a
 * live query that narrows what the rule reads. Derived rows change in the same turn as the source,
 * so a read after the source syncs sees rows that agree with it.
 */
export function createDerivedCollection<TSource extends object, TRow extends object>({
  source,
  getKey,
  derive,
}: {
  source: Collection<TSource>;
  getKey: (row: TRow) => string;
  derive: (rows: TSource[]) => TRow[];
}): Collection<TRow, string> {
  return createCollection<TRow, string>({
    getKey,
    sync: {
      sync: ({ begin, write, commit, markReady, markError }) => {
        // What each key last held, so a source change writes only the rows it changed.
        let written = new Map<string, string>();
        const apply = () => {
          const next = new Map(
            derive(source.toArray).map((row) => [getKey(row), { row, json: JSON.stringify(row) }]),
          );
          const inserted = [...next].filter(([key]) => !written.has(key));
          const updated = [...next].filter(
            ([key, { json }]) => written.has(key) && written.get(key) !== json,
          );
          const deleted = [...written.keys()].filter((key) => !next.has(key));
          written = new Map([...next].map(([key, { json }]) => [key, json]));
          if (inserted.length + updated.length + deleted.length === 0) {
            return;
          }
          begin();
          for (const [, { row }] of inserted) {
            write({ type: "insert", value: row });
          }
          for (const [, { row }] of updated) {
            write({ type: "update", value: row });
          }
          for (const key of deleted) {
            write({ type: "delete", key });
          }
          // Nothing writes to a derived collection optimistically, so its commits apply at once.
          void commit();
        };
        const subscription = source.subscribeChanges(() => {
          if (source.isReady()) {
            apply();
          }
        });
        const stopReady = source.onFirstReady(() => {
          apply();
          markReady();
        });
        source.preload().catch(markError);
        return () => {
          subscription.unsubscribe();
          stopReady();
        };
      },
    },
  });
}
