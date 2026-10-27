import { SqliteLofiAdapter, type LofiSqliteGuardedResult } from "@fragno-dev/lofi/sqlite";
import { wrapWaSqliteDatabase, type LofiSqliteViews } from "@fragno-dev/lofi/sqlite/worker";
import type { PageDefinition } from "@fragno-private/backoffice-ui/pages/definition";
import { pageQueryParams } from "@fragno-private/backoffice-ui/pages/rows";

import {
  AUTOMATION_PAGE_FUNCTIONS,
  AUTOMATION_PAGE_RELATIONS,
  automationPageViewEngine,
} from "@/fragno/automation/lofi/page-relations";
import { AUTOMATION_REPLICA_SCHEMAS } from "@/fragno/automation/lofi/replica-schemas";
import { automationViews } from "@/fragno/automation/lofi/views";

/**
 * Names what page queries are checked against, so a cached build is checked again when the
 * relations or functions pages read change.
 */
export const PAGE_QUERY_CATALOG = JSON.stringify({
  relations: AUTOMATION_PAGE_RELATIONS,
  functions: AUTOMATION_PAGE_FUNCTIONS,
});

let checking: Promise<LofiSqliteViews> | undefined;

/**
 * Why one of the page's queries cannot run, named by the query, or null. Each query runs as the
 * replica worker runs it, with the same relations, functions, and guard, on an empty in-memory
 * database of the replica's tables, so the build reports SQL that does not parse, reads what pages
 * cannot, binds the wrong number of values, or does not select a declared column.
 */
export async function pageQueriesError(definition: PageDefinition): Promise<string | null> {
  checking ??= openCheckingViews().catch((error: unknown) => {
    checking = undefined;
    throw error;
  });
  const views = await checking;
  for (const [name, query] of Object.entries(definition.queries)) {
    const id = `check-${crypto.randomUUID()}`;
    let result: LofiSqliteGuardedResult | undefined;
    // Views report their first result before materialize returns, and nothing runs meanwhile.
    // Guarded views report their failures as results, and these are destroyed before a refresh.
    views.materialize(
      id,
      { sql: query.sql, params: pageQueryParams(query, 0) },
      (data) => {
        result = data as LofiSqliteGuardedResult;
      },
      () => {},
    );
    views.destroy(id);
    if (result === undefined) {
      throw new Error("A guarded view reports its result as it materializes.");
    }
    if (result.status === "error") {
      return `queries.${name}: ${result.message}`;
    }
    const selected = new Set(result.columns);
    const missing = Object.keys(query.columns).filter((column) => !selected.has(column));
    if (missing.length > 0) {
      return `queries.${name}: The query declares ${missing.map((column) => `"${column}"`).join(", ")}, which it does not select. It selects: ${result.columns.join(", ")}.`;
    }
  }
  return null;
}

async function openCheckingViews(): Promise<LofiSqliteViews> {
  // Imported on first check, so starting the Worker does not load SQLite.
  const [{ default: SQLiteESMFactory }, SQLite, { loadWaSqliteWasm }] = await Promise.all([
    import("@journeyapps/wa-sqlite/dist/wa-sqlite.mjs"),
    import("@journeyapps/wa-sqlite"),
    // By its aliased path, which Node builds and tests resolve to a module that compiles the file.
    import("@/artifacts/pages/wa-sqlite-wasm.server"),
  ]);
  const wasm = await loadWaSqliteWasm();
  const module = await SQLiteESMFactory({
    instantiateWasm(
      imports: WebAssembly.Imports,
      receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
    ) {
      void WebAssembly.instantiate(wasm, imports).then((instance) => {
        receive(instance, wasm);
      });
      return {};
    },
  });
  const sqlite3 = SQLite.Factory(module);
  const db = await sqlite3.open_v2(":memory:");
  const database = wrapWaSqliteDatabase({
    module,
    sqlite3,
    db,
    close: async () => {
      await sqlite3.close(db);
    },
  });
  const registrations = [...AUTOMATION_REPLICA_SCHEMAS, ...automationViews.localSchemas];
  // Creates the replica's tables, empty.
  await SqliteLofiAdapter.open({
    database,
    schemas: AUTOMATION_REPLICA_SCHEMAS,
    localSchemas: automationViews.localSchemas,
    projections: [],
  });
  return automationPageViewEngine.open({ connection: database.connection, registrations });
}
