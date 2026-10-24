import type { LofiZqlResult, LofiZqlView } from "@fragno-dev/lofi/zql";
import { useSyncExternalStore } from "react";

/**
 * The live result of a ZQL view. The replica's worker maintains the view while a component uses
 * it, so create `view` once per query, for example with `useMemo`.
 */
export function useLofiZql<TData>(view: LofiZqlView<TData>): LofiZqlResult<TData> {
  return useSyncExternalStore(
    (onChange) => view.listen(onChange),
    () => view.get(),
    () => view.get(),
  );
}
