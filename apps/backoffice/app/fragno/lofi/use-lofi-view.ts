import type { LofiSqliteView, LofiSqliteViewResult } from "@fragno-dev/lofi/sqlite";
import { useCallback, useSyncExternalStore } from "react";

const LOADING: LofiSqliteViewResult<never> = { status: "loading" };

/**
 * The live result of a replica view, or loading without one. The replica's worker maintains the
 * view while a component uses it, so create `view` once per query, for example with `useMemo`.
 */
export function useLofiView<TData>(
  view: LofiSqliteView<TData> | null,
): LofiSqliteViewResult<TData> {
  const subscribe = useCallback(
    (onChange: () => void) => (view ? view.listen(onChange) : () => {}),
    [view],
  );
  const read = useCallback(() => (view ? view.get() : LOADING), [view]);
  return useSyncExternalStore(subscribe, read, read);
}
