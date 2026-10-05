import type { BackofficeExecutionContext } from "./context";
import type { BackofficeObjectHttp, FetchObject } from "./object-registry";

/** Gives route callers only the transport bound to their authenticated execution. */
export function authorizedBackofficeObjectHttp(
  http: Pick<BackofficeObjectHttp, "fetchAuthorized">,
  execution: BackofficeExecutionContext,
): FetchObject {
  return {
    async fetch(request) {
      return await http.fetchAuthorized(request, { execution, propagationContext: null });
    },
  };
}
