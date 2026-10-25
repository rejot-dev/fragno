import type { LofiSqliteClient } from "@fragno-dev/lofi/sqlite";

import { readScenarioReplicaView } from "@/fragno/lofi/scenario-replica-database";

import { automationReadView, type AutomationReadArgs, type AutomationReadName } from "./replica";

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
