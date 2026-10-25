import {
  lofiSqliteReadViews,
  type LofiSqliteClient,
  type LofiSqliteReadArgs,
  type LofiSqliteViewResult,
} from "@fragno-dev/lofi/sqlite";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { useCurrentBackofficeContext } from "@/components/backoffice/current-context";
import { getWorkerReplica } from "@/fragno/lofi/browser-replica";
import { useLofiView } from "@/fragno/lofi/use-lofi-view";

import type { automationReads } from "./replica-host";
import { AUTOMATION_READ_VIEWS, AUTOMATION_REPLICA_SCHEMAS } from "./replica-schemas";
import { describeAutomationReplicaSource, type AutomationReplicaSource } from "./replica-source";
import { automationViews } from "./views";

/**
 * The scope's Automations replica in this tab, served by its replica worker, with the views its
 * projections keep. Tabs of one scope share the worker that leads.
 */
export function getAutomationReplica(source: AutomationReplicaSource): Promise<LofiSqliteClient> {
  const description = describeAutomationReplicaSource(source);
  return getWorkerReplica({
    target: { baseUrl: description.baseUrl, adapterIdentity: source.adapterIdentity },
    schemas: [...AUTOMATION_REPLICA_SCHEMAS, ...automationViews.localSchemas],
    startWorker: (name) =>
      new Worker(new URL("./replica.worker.ts", import.meta.url), { type: "module", name }),
  });
}

type CurrentAutomationReplica = {
  /** Null until the scope's replica opens, and when it cannot. */
  replica: LofiSqliteClient | null;
  /** Whether the replica holds everything its backend had when synchronization started. */
  caughtUp: boolean;
  /**
   * Why the replica cannot be read: the scope has none, it could not open, or its download fails
   * before it caught up, while it retries.
   */
  error: string | null;
};

const subscribeToNothing = () => () => {};
const noStatus = () => null;

/**
 * The current scope's Automations replica, for views that render before it opens instead of
 * suspending, such as the agent drawer and pages rendered on the server.
 */
export function useCurrentAutomationReplica(): CurrentAutomationReplica {
  const { automationReplicaSource } = useCurrentBackofficeContext();
  const source = automationReplicaSource.status === "ready" ? automationReplicaSource.source : null;
  const sourceKey = source ? describeAutomationReplicaSource(source).resourceKey : null;
  const unavailable =
    automationReplicaSource.status === "unavailable" ? automationReplicaSource.message : null;
  const [opened, setOpened] = useState<{
    sourceKey: string;
    replica: LofiSqliteClient | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!source || !sourceKey) {
      return () => {
        cancelled = true;
      };
    }
    void getAutomationReplica(source).then(
      (replica) => {
        if (!cancelled) {
          setOpened({ sourceKey, replica, error: null });
        }
      },
      (cause: unknown) => {
        if (!cancelled) {
          setOpened({
            sourceKey,
            replica: null,
            error: cause instanceof Error ? cause.message : "Automation synchronization failed.",
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source, sourceKey]);

  // A replica opened for another scope is not this one's.
  const current = opened?.sourceKey === sourceKey ? opened : null;
  const replica = current?.replica ?? null;
  const status = useSyncExternalStore(
    replica?.subscribeStatus ?? subscribeToNothing,
    replica?.getStatus ?? noStatus,
    noStatus,
  );
  const caughtUp = status?.phase === "caught-up";
  // A replica that caught up keeps its views through later failures, which the stream retries.
  const downloadError = caughtUp ? null : (status?.error ?? null);
  return { replica, caughtUp, error: unavailable ?? current?.error ?? downloadError };
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
 * render before the replica opens can call it unconditionally.
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
