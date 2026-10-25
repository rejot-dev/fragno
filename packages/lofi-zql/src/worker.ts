import type { LofiSqliteViewEngine } from "@fragno-dev/lofi/sqlite/worker";

import { LofiZqlEngine } from "./engine";
import { ZQL_VIEW_KIND, type LofiZqlViewQuery } from "./view-query";

/**
 * Maintains the ZQL views pages ask for incrementally, as the replica applies outbox entries. Pass
 * it in the worker's `engines`.
 */
export const zqlViewEngine: LofiSqliteViewEngine = {
  kind: ZQL_VIEW_KIND,
  open({ connection, registrations }) {
    const engine = new LofiZqlEngine(connection, registrations);
    return {
      materialize(id, query, listener) {
        // Pages send what `lofiZql` built.
        engine.materialize(id, query as LofiZqlViewQuery, listener);
      },
      destroy(id) {
        engine.destroy(id);
      },
      refresh() {
        engine.refresh();
      },
    };
  },
};
