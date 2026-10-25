import type { LofiSqliteView, LofiSqliteViewResult } from "@fragno-dev/lofi/sqlite";
import { useSyncExternalStore } from "react";

/**
 * The live result of a replica view. The replica's worker maintains the view while a component
 * uses it, so create `view` once per query, for example with `useMemo`.
 */
export function useLofiView<TData>(view: LofiSqliteView<TData>): LofiSqliteViewResult<TData> {
  return useSyncExternalStore(
    (onChange) => view.listen(onChange),
    () => view.get(),
    () => view.get(),
  );
}
