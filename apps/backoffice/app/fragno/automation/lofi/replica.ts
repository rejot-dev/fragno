import {
  lofiSqliteReadViews,
  type LofiSqliteClient,
  type LofiSqliteReadArgs,
  type LofiSqliteViewResult,
} from "@fragno-dev/lofi/sqlite";
import { useMemo } from "react";

import { getWorkerReplica } from "@/fragno/lofi/browser-replica";
import { useLofiView } from "@/fragno/lofi/use-lofi-view";

import {
  describeAutomationCollectionSource,
  type AutomationCollectionSource,
} from "../tanstack/browser-database";
import type { automationReads } from "./replica-host";
import { AUTOMATION_READ_VIEWS, AUTOMATION_REPLICA_SCHEMAS } from "./replica-schemas";
import { automationViews } from "./views";

/**
 * The scope's Automations replica in this tab, served by its replica worker, with the views its
 * projections keep. It streams the same outbox as the scope's TanStack coordinator, over its own
 * connection.
 */
export function getAutomationReplica(
  source: AutomationCollectionSource,
): Promise<LofiSqliteClient> {
  const description = describeAutomationCollectionSource(source);
  return getWorkerReplica({
    baseUrl: description.baseUrl,
    resourceKey: description.resourceKey,
    schemas: [...AUTOMATION_REPLICA_SCHEMAS, ...automationViews.localSchemas],
    startWorker: (baseUrl) =>
      new Worker(new URL("./replica.worker.ts", import.meta.url), {
        type: "module",
        name: baseUrl,
      }),
  });
}

type AutomationReads = typeof automationReads;
export type AutomationReadName = keyof AutomationReads;
export type AutomationReadArgs<TName extends AutomationReadName> = LofiSqliteReadArgs<
  AutomationReads[TName]
>;
export type AutomationReadData<TName extends AutomationReadName> = ReturnType<
  AutomationReads[TName]
>;

/** A live view of one of `automationReads`, which the replica worker maintains while it is used. */
export const automationReadView = lofiSqliteReadViews<AutomationReads>(AUTOMATION_READ_VIEWS);

/**
 * The live result of one of `automationReads`. Without a replica it stays loading, so views that
 * read the TanStack collections on some pages can call it unconditionally.
 */
export function useAutomationRead<TName extends AutomationReadName>(
  replica: LofiSqliteClient | null,
  read: TName,
  args: AutomationReadArgs<TName>,
): LofiSqliteViewResult<AutomationReadData<TName>> {
  // Arguments are plain data, so a new view opens only when their value changes.
  const argsKey = JSON.stringify(args ?? null);
  const view = useMemo(
    () =>
      replica
        ? automationReadView(replica, read, JSON.parse(argsKey) as AutomationReadArgs<TName>)
        : null,
    [replica, read, argsKey],
  );
  return useLofiView(view);
}
