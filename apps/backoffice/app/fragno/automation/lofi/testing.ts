import { assert } from "vitest";

import type { LofiSqliteClient, LofiSqliteGuardedResult } from "@fragno-dev/lofi/sqlite";
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
