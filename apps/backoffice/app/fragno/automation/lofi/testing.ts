import { assert } from "vitest";

import type {
  LofiSqliteClient,
  LofiSqliteGuardedResult,
  SqliteValue,
} from "@fragno-dev/lofi/sqlite";
import { lofiSqliteTableName } from "@fragno-dev/lofi/sqlite";
import type { PageQuery } from "@fragno-private/backoffice-ui/pages/definition";
import { pageQueryParams } from "@fragno-private/backoffice-ui/pages/rows";

import {
  readScenarioReplicaView,
  type ScenarioReplicaScope,
} from "@/fragno/lofi/scenario-replica-database";

import { automationReadView, type AutomationReadArgs, type AutomationReadName } from "./replica";
import { AUTOMATION_PAGE_VIEWS } from "./replica-schemas";
import { automationViewsSchema } from "./views";

/**
 * What one of `automationReads` returns for everything the replica applied, read through the
 * replica's worker as a page reads it.
 */
export function readAutomationReplica<TName extends AutomationReadName>(
  replica: LofiSqliteClient,
  read: TName,
  args: AutomationReadArgs<TName>,
) {
  return readScenarioReplicaView(automationReadView(replica, read, args));
}

/**
 * A page query's result at `now` for everything the replica applied, read through the replica's
 * worker as the page reads it. Fails when the query cannot run.
 */
export async function readAutomationPageQuery(
  replica: LofiSqliteClient,
  query: PageQuery,
  now: number,
) {
  const result = await readScenarioReplicaView(
    replica.view<LofiSqliteGuardedResult>(AUTOMATION_PAGE_VIEWS, {
      sql: query.sql,
      params: pageQueryParams(query, now),
    }),
  );
  if (result.status === "error") {
    throw new Error(result.message);
  }
  return result;
}

/**
 * The rows SQL over the page relations, such as `runs` and `events`, returns once the scope's
 * replica holds what the runtime wrote so far, by column, as the replica stores them: times in
 * milliseconds, booleans as 0 or 1, and JSON as text. For checking what reached the browser; drain
 * the scope first to read what pending work writes.
 */
export async function queryAutomationReplica(
  scope: ScenarioReplicaScope,
  sql: string,
  params: readonly SqliteValue[] = [],
): Promise<Record<string, SqliteValue>[]> {
  await scope.sync();
  const result = await readScenarioReplicaView(
    scope.replica.view<LofiSqliteGuardedResult>(AUTOMATION_PAGE_VIEWS, { sql, params }),
  );
  if (result.status === "error") {
    throw new Error(result.message);
  }
  return result.rows.map((row) =>
    Object.fromEntries(result.columns.map((column, index) => [column, row[index] ?? null])),
  );
}

/**
 * Rebuilds the replica's projections from the events it stores, as a change to their code would,
 * and checks that this gives the rows the outbox built, with rows in each of `tables`.
 */
export async function assertAutomationProjectionsRebuild(
  scope: ScenarioReplicaScope,
  tables: ReadonlyArray<keyof typeof automationViewsSchema.tables>,
) {
  await scope.drain();
  const { before, after } = await scope.rebuildProjections();
  for (const table of tables) {
    assert.isNotEmpty(before[lofiSqliteTableName({ schema: automationViewsSchema }, table)], table);
  }
  assert.deepEqual(after, before);
}
