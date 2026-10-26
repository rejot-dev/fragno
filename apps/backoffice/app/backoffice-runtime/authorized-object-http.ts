import type { BackofficeExecutionContext } from "./context";
import type { BackofficeObjectHttp, FetchCommands } from "./object-registry";

/** Gives route callers only the transport bound to their authenticated execution. */
export function authorizedBackofficeObjectHttp(
  http: Pick<BackofficeObjectHttp, "fetchAuthorized">,
  execution: BackofficeExecutionContext,
): FetchCommands {
  return {
    async fetch(request) {
      return await http.fetchAuthorized(request, { execution, propagationContext: null });
    },
  };
}
