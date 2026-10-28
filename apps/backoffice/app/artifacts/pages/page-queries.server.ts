import type { PageDefinition } from "@fragno-private/backoffice-ui/pages/definition";
import { pageQueryParams } from "@fragno-private/backoffice-ui/pages/rows";

import type { AutomationsCommands } from "@/backoffice-runtime/object-registry";
import { AUTOMATION_PAGE_RELATIONS } from "@/fragno/automation/lofi/page-relations";

/**
 * Names what page queries are checked against, so a cached build is checked again when the
 * relations pages read change.
 */
export const PAGE_QUERY_CATALOG = JSON.stringify({ relations: AUTOMATION_PAGE_RELATIONS });

/**
 * Why one of the page's queries cannot run, named by the query, or null. The scope's Automations
 * object runs each query once on an empty database of the relations pages read, so the build
 * reports SQL that does not parse, reads what pages do not have, binds the wrong number of
 * values, or does not select a declared column.
 */
export async function pageQueriesError(
  definition: PageDefinition,
  automations: Pick<AutomationsCommands, "checkPageQueries">,
): Promise<string | null> {
  const queries = Object.entries(definition.queries);
  const checks = await automations.checkPageQueries(
    queries.map(([, query]) => ({
      sql: query.sql,
      // SQLite has no booleans: the replica stores them, and binds them, as 1 and 0.
      params: pageQueryParams(query, 0).map((value) =>
        typeof value === "boolean" ? Number(value) : value,
      ),
    })),
  );
  for (const [index, [name, query]] of queries.entries()) {
    const check = checks[index];
    if (check.kind === "failed") {
      return `queries.${name}: ${
        check.message.startsWith("no such table:")
          ? `${check.message}. Read one of: ${AUTOMATION_PAGE_RELATIONS.map((relation) => relation.name).join(", ")}.`
          : check.message
      }`;
    }
    const selected = new Set(check.columns);
    const missing = Object.keys(query.columns).filter((column) => !selected.has(column));
    if (missing.length > 0) {
      return `queries.${name}: The query declares ${missing.map((column) => `"${column}"`).join(", ")}, which it does not select. It selects: ${check.columns.join(", ")}.`;
    }
  }
  return null;
}
