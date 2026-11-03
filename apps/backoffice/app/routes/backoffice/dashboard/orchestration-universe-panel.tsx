import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { LofiSqliteClient } from "@fragno-dev/lofi/sqlite";
import { PaneSpinner } from "@fragno-private/design-system/feedback/pane-message";
import { BackofficeSystemState } from "@fragno-private/design-system/feedback/system-state";
import { OrchestrationUniverseGraph } from "@fragno-private/design-system/orchestration/orchestration-universe";
import type { OrchestrationUniverseScopeStatus } from "@fragno-private/design-system/orchestration/orchestration-universe-model";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  backofficeRuntimeScopeFromResolvedScope,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import { useClock } from "@/components/backoffice/use-clock";
import { scopeIdentity } from "@/fragno/automation/forward-accepts";
import { useAutomationRead, useAutomationReplica } from "@/fragno/automation/lofi/replica";
import type { AutomationReplicaSource } from "@/fragno/automation/lofi/replica-source";
import type { RuntimeToolWorkflowDescriptor } from "@/fragno/runtime-tools/workflow-catalog";

import { workflowOutsideCalls } from "./orchestration-outside-systems";
import { projectOrchestrationUniverse, type UniverseReadScope } from "./orchestration-universe";
import { dashboardBucketStarts } from "./overview";
import { useScopeOrchestrationGraph } from "./scope-orchestration-graph";

const CLOCK_TICK_MS = 60_000;
// A scope whose reader has not reported yet is opening its replica.
const OPENING: ScopeRead = { kind: "loading", fraction: null };

/** A scope the universe reads from its own replica, and where that replica is served. */
type UniverseScopeSource = { label: string; source: AutomationReplicaSource };

/** The scopes the loader describes for an organization's universe besides the organization. */
export type OrchestrationUniverseScopes = {
  projects: readonly UniverseScopeSource[];
  /** The person looking, whose personal scope they can read; null before they have one. */
  viewer: UniverseScopeSource | null;
  /** The names of the organization's members, by user ID, for the members who forward into it. */
  memberNames: Readonly<Record<string, string>>;
  /** What could not be described, such as a project whose backend did not answer. */
  problems: readonly string[];
};

/**
 * How far reading a scope got: what it holds once its replica caught up, with the records that
 * could not be read, if any, or why it could not be read at all.
 */
type ScopeRead =
  | (NonNullable<UniverseReadScope["read"]> & { unreadRecords: string | null })
  | OrchestrationUniverseScopeStatus;

/** Names as a sentence lists them: "A", "A and B", "A, B and C". */
function listed(names: readonly string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join("");
}

/** The records a graph was drawn without, as one phrase; null when none were missed. */
function unreadRecords(recordErrors: readonly string[]): string | null {
  return recordErrors.length > 0 ? recordErrors.join(", ") : null;
}

/**
 * The outside systems a scope's workflows call, from the scripts their last runs ran, which the
 * replica keeps: null until read, and none, with the error, when they could not be read.
 */
function useWorkflowOutsideCalls(
  replica: LofiSqliteClient | null,
  catalog: readonly RuntimeToolWorkflowDescriptor[],
) {
  const programs = useAutomationRead(replica, "latestWorkflowPrograms", undefined);
  const programsData = programs.status === "ready" ? programs.data : null;
  const failed = programs.status === "error";
  const calls = useMemo(
    () => (programsData ? workflowOutsideCalls(programsData, catalog) : failed ? [] : null),
    [programsData, failed, catalog],
  );
  return { calls, recordErrors: failed ? ["workflow scripts"] : [] };
}

/**
 * Reads one scope's graph, routes, and deliveries from its own replica and hands them up; it draws
 * nothing itself, so the universe can draw every planet together. The replica stays open while
 * this is mounted.
 */
function ScopeGraphReader({
  scopeId,
  scope,
  label,
  source,
  since,
  catalog,
  onRead,
}: {
  scopeId: string;
  scope: BackofficeContextScope;
  label: string;
  source: AutomationReplicaSource;
  since: number;
  catalog: readonly RuntimeToolWorkflowDescriptor[];
  onRead: (scopeId: string, read: ScopeRead) => void;
}) {
  const opened = useAutomationReplica(source, null);
  const read = useScopeOrchestrationGraph(opened.replica, { scope, scopeLabel: label, since });
  const deliveries = useAutomationRead(opened.replica, "recentForwardDeliveries", { since });
  const outside = useWorkflowOutsideCalls(opened.replica, catalog);
  const error =
    opened.error ??
    (read.status === "error" ? read.message : null) ??
    (deliveries.status === "error" ? deliveries.message : null);
  // A replica still catching up would redraw the planet with every batch, so it shows once caught up.
  const caughtUp =
    opened.caughtUp &&
    read.status === "ready" &&
    deliveries.status === "ready" &&
    outside.calls !== null;
  const graph = caughtUp ? read.graph : null;
  const routes = caughtUp ? read.inputs.routes : null;
  const delivered = caughtUp ? deliveries.data : null;
  const calls = caughtUp ? outside.calls : null;
  // A phrase rather than the list, which is a new array every render.
  const unread = caughtUp ? unreadRecords([...read.recordErrors, ...outside.recordErrors]) : null;
  const fraction = opened.fraction;
  useEffect(() => {
    onRead(
      scopeId,
      error !== null
        ? { kind: "failed", message: error }
        : graph && routes && delivered && calls
          ? { graph, routes, deliveries: delivered, calls, unreadRecords: unread }
          : { kind: "loading", fraction },
    );
  }, [scopeId, graph, routes, delivered, calls, unread, error, fraction, onRead]);
  return null;
}

/**
 * The organization as one planet among its projects, the members who forward into it, and the
 * person looking, with the forwards between them. The organization's projects and the person's
 * own scope open with the universe, which shows at once: their planets ring while their replicas
 * download, and draw their graphs once caught up. Other members' planets are what the organization
 * knows of them. The replicas close once the universe is left.
 */
export function OrganizationUniverse({
  replica,
  selectedScope,
  scopes,
  runtimeToolCatalog,
}: {
  replica: LofiSqliteClient;
  selectedScope: BackofficeScopeSelection;
  scopes: OrchestrationUniverseScopes;
  /** The runtime tools workflows call, which name the outside systems they reach. */
  runtimeToolCatalog: readonly RuntimeToolWorkflowDescriptor[];
}) {
  const now = useClock(CLOCK_TICK_MS);
  // The window start only moves when a new bucket begins, so the reads restart rarely.
  const since = dashboardBucketStarts(now)[0] ?? now;
  const organizationScope = useMemo(
    () => backofficeRuntimeScopeFromResolvedScope(selectedScope),
    [selectedScope],
  );
  const organization = useScopeOrchestrationGraph(replica, {
    scope: organizationScope,
    scopeLabel: selectedScope.label,
    since,
  });
  const deliveries = useAutomationRead(replica, "recentForwardDeliveries", { since });
  const outside = useWorkflowOutsideCalls(replica, runtimeToolCatalog);
  const organizationCalls = outside.calls;
  const readScopes = useMemo(() => {
    // The loader describes runtime scopes the person can read, never System.
    const describe = ({ label, source }: UniverseScopeSource) => {
      const scope = backofficeRuntimeScopeFromResolvedScope(
        source.resolvedScope,
      ) as BackofficeContextScope;
      return { label, source, scope, scopeId: scopeIdentity(scope) };
    };
    return {
      projects: scopes.projects.map(describe),
      viewer: scopes.viewer && describe(scopes.viewer),
    };
  }, [scopes.projects, scopes.viewer]);
  const [scopeReads, setScopeReads] = useState<ReadonlyMap<string, ScopeRead>>(new Map());
  const onScopeRead = useCallback((scopeId: string, read: ScopeRead) => {
    setScopeReads((current) => new Map(current).set(scopeId, read));
  }, []);

  // Laying the universe out is costly, so it is projected again only when what it shows changes.
  const organizationGraph = organization.status === "ready" ? organization.graph : null;
  const organizationInputs = organization.status === "ready" ? organization.inputs : null;
  const deliveriesData = deliveries.status === "ready" ? deliveries.data : null;
  const universe = useMemo(() => {
    if (!organizationGraph || !organizationInputs || !deliveriesData || !organizationCalls) {
      return null;
    }
    const readScope = ({
      scope,
      scopeId,
      label,
    }: (typeof readScopes.projects)[number]): UniverseReadScope => {
      const read = scopeReads.get(scopeId) ?? OPENING;
      return "graph" in read ? { scope, label, read } : { scope, label, read: null, status: read };
    };
    return projectOrchestrationUniverse({
      organization: {
        scope: organizationScope,
        graph: organizationGraph,
        routes: organizationInputs.routes,
        deliveries: deliveriesData,
        calls: organizationCalls,
      },
      projects: readScopes.projects.map(readScope),
      viewer: readScopes.viewer && readScope(readScopes.viewer),
      recentForwards: organizationInputs.recentForwards,
      memberNames: scopes.memberNames,
    });
  }, [
    organizationScope,
    organizationGraph,
    organizationInputs,
    deliveriesData,
    organizationCalls,
    readScopes,
    scopeReads,
    scopes.memberNames,
  ]);

  // Scopes start reading with the universe, before the organization's graph is drawn.
  const readers = [...readScopes.projects, ...(readScopes.viewer ? [readScopes.viewer] : [])].map(
    (read) => (
      <ScopeGraphReader
        key={read.scopeId}
        scopeId={read.scopeId}
        scope={read.scope}
        label={read.label}
        source={read.source}
        since={since}
        catalog={runtimeToolCatalog}
        onRead={onScopeRead}
      />
    ),
  );
  // The organization's routes and deliveries are what the universe is drawn around.
  const readError =
    organization.status === "error"
      ? organization.message
      : deliveries.status === "error"
        ? deliveries.message
        : null;
  if (readError !== null) {
    return (
      <BackofficeSystemState
        tone="error"
        title="The universe could not be read."
        description={readError}
      />
    );
  }
  // A planet drawn without some of its records is drawn with what was read, and named here.
  const missedBy = new Map<string, string[]>();
  const missed = (unread: string | null, label: string) => {
    if (unread !== null) {
      missedBy.set(unread, [...(missedBy.get(unread) ?? []), label]);
    }
  };
  if (organization.status === "ready") {
    missed(
      unreadRecords([...organization.recordErrors, ...outside.recordErrors]),
      selectedScope.label,
    );
  }
  for (const { scopeId, label } of [
    ...readScopes.projects,
    ...(readScopes.viewer ? [readScopes.viewer] : []),
  ]) {
    const read = scopeReads.get(scopeId);
    if (read && "graph" in read) {
      missed(read.unreadRecords, label);
    }
  }
  // Scopes that missed the same records are named together.
  const incomplete = [...missedBy].map(([unread, labels]) => `${unread} of ${listed(labels)}`);
  if (universe === null) {
    return (
      <>
        {readers}
        <PaneSpinner label="Reading the organization's routes and events" />
      </>
    );
  }
  return (
    <div className="flex flex-col gap-2 pt-3">
      {readers}
      {scopes.problems.length > 0 ? (
        <p className="text-xs text-[var(--bo-muted)]">{scopes.problems.join(" ")}</p>
      ) : null}
      {incomplete.length > 0 ? (
        <p className="text-xs text-[var(--bo-failed)]">
          {incomplete.join("; ")} could not be read, so the universe may be incomplete.
        </p>
      ) : null}
      <div className="h-[min(78vh,820px)] min-h-[420px]">
        <OrchestrationUniverseGraph universe={universe} />
      </div>
    </div>
  );
}
