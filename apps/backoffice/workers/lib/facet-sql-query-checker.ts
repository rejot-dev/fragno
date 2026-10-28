import type { SqlQuery, SqlQueryCheck, SqlQueryChecker } from "./backoffice-object-implementation";

/**
 * The facet's class. Each check runs in a transaction that always rolls back, so the facet's
 * database stays empty, whatever a query or an older schema did.
 */
const CHECKER_MODULE = `import { DurableObject } from "cloudflare:workers";

const ROLLBACK = new Error("Rolls the check back.");

export class SqlQueryChecker extends DurableObject {
  check(schema, query) {
    const { storage } = this.ctx;
    let check;
    try {
      storage.transactionSync(() => {
        for (const statement of schema) {
          storage.sql.exec(statement);
        }
        try {
          const cursor = storage.sql.exec(query.sql, ...query.params);
          cursor.toArray();
          check = { kind: "ran", columns: cursor.columnNames };
        } catch (error) {
          check = { kind: "failed", message: error instanceof Error ? error.message : String(error) };
        }
        throw ROLLBACK;
      });
    } catch (error) {
      if (error !== ROLLBACK) {
        throw error;
      }
    }
    return check;
  }
}
`;

/**
 * Each check is one call, and the limit holds per call. A query on an empty database ends within
 * milliseconds, so the limit only ends one that never would, before it stalls the host object.
 */
const CHECK_CPU_MS = 1_000;

type SqlQueryCheckerFacet = {
  check(schema: readonly string[], query: SqlQuery): Promise<SqlQueryCheck>;
};

/**
 * Checks queries in a facet of `state` whose class is loaded as a Dynamic Worker: the facet has a
 * database of its own, which the queries cannot see past, and runs under its own CPU limit.
 */
export function createFacetSqlQueryChecker(
  state: DurableObjectState,
  loader: WorkerLoader,
): SqlQueryChecker {
  return async (schema, queries) => {
    const checker = state.facets.get("sql-query-checker", () => ({
      class: loader
        .get(`sql-query-checker-${hashCode(CHECKER_MODULE)}`, () => ({
          compatibilityDate: "2026-08-06",
          mainModule: "checker.js",
          modules: { "checker.js": CHECKER_MODULE },
          globalOutbound: null,
          limits: { cpuMs: CHECK_CPU_MS },
        }))
        .getDurableObjectClass("SqlQueryChecker"),
    })) as unknown as SqlQueryCheckerFacet;
    const checks: SqlQueryCheck[] = [];
    for (const query of queries) {
      checks.push(await checker.check(schema, query));
    }
    return checks;
  };
}

/** Names the module's code, so a changed module loads as a new Dynamic Worker. */
function hashCode(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
