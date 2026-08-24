import { Activity, ArrowLeft, ChevronRight, Clock3, Workflow, X } from "lucide-react";
import {
  Component,
  Suspense,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { eq, toArray, useLiveQuery } from "@tanstack/react-db";

import { backofficeRuntimeScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { BackofficeUiErrorBoundary, BackofficeUiRenderer } from "@/backoffice-ui/renderer";
import { parseBackofficeUiResult } from "@/backoffice-ui/result";
import { sendBackofficeWorkflowEvent } from "@/backoffice-ui/workflow-events.client";
import { ClientOnly } from "@/components/client-only";
import {
  describeAutomationCollectionSource,
  getAutomationBrowserDatabase,
  type AutomationBrowserDatabase,
  type AutomationCollectionSource,
} from "@/fragno/automation/tanstack/browser-database";
import {
  currentWorkflowWaitingEventTypes,
  type WorkflowRunEvent,
  type WorkflowStepRunState,
} from "@/routes/backoffice/automations/script-view/workflow-run-presentation";
import { WorkflowStepGeneratedUi } from "@/routes/backoffice/automations/script-view/workflow-step-generated-ui";

import type { AutomationCollectionSourceState } from "./current-context";
import { workflowRunErrorText } from "./global-workflow-drawer-utils";

const DEFAULT_WIDTH = 520;
const MIN_WIDTH = 360;
const MAX_WIDTH = 900;
const RESIZE_STEP = 24;
const STORAGE_KEY = "backoffice:global-workflow-drawer-width";
const drawerWidthListeners = new Set<() => void>();
let drawerWidthSnapshot: number | undefined;

type RecentWorkflowRun = {
  id: string;
  instanceId: string;
  workflowName: string;
  remoteWorkflowName: string | null;
  status: string;
  output: unknown;
  errorName: string | null;
  errorMessage: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  steps: readonly {
    id: string;
    stepKey: string;
    parentStepKey: string | null;
    name: string;
    type: string;
    status: "waiting" | "completed" | "errored";
    attempts: number;
    errorMessage: string | null;
    waitEventType: string | null;
    result: unknown;
    createdAt: Date | string;
    updatedAt: Date | string;
  }[];
  workflowEvents: readonly WorkflowRunEvent[];
};

export function GlobalWorkflowDrawer({
  open,
  sourceState,
  onClose,
}: {
  open: boolean;
  sourceState: AutomationCollectionSourceState | null;
  onClose: () => void;
}) {
  const width = useSyncExternalStore(
    subscribeToDrawerWidth,
    getDrawerWidthSnapshot,
    getServerDrawerWidthSnapshot,
  );
  const setWidth = useCallback((nextWidth: number | ((currentWidth: number) => number)) => {
    const resolvedWidth =
      typeof nextWidth === "function" ? nextWidth(getDrawerWidthSnapshot()) : nextWidth;
    setDrawerWidthSnapshot(resolvedWidth);
  }, []);
  const draggingRef = useRef(false);
  const clampWidth = useCallback(
    (value: number) =>
      Math.min(Math.min(MAX_WIDTH, window.innerWidth - 32), Math.max(MIN_WIDTH, value)),
    [],
  );

  const stopDragging = useCallback(() => {
    if (!draggingRef.current) {
      return;
    }
    draggingRef.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  const resizeFromPointer = useCallback(
    (event: PointerEvent) => {
      if (!draggingRef.current) {
        return;
      }
      setWidth(clampWidth(window.innerWidth - event.clientX));
    },
    [clampWidth],
  );

  useEffect(() => {
    window.addEventListener("pointermove", resizeFromPointer);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);
    window.addEventListener("blur", stopDragging);
    return () => {
      window.removeEventListener("pointermove", resizeFromPointer);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
      window.removeEventListener("blur", stopDragging);
      stopDragging();
    };
  }, [resizeFromPointer, stopDragging]);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
    } catch {
      // Drawer sizing persistence is optional when storage is unavailable.
    }
  }, [width]);

  const resizeFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === "ArrowLeft" ? 1 : event.key === "ArrowRight" ? -1 : 0;
    if (direction === 0 && event.key !== "Home" && event.key !== "End") {
      return;
    }
    event.preventDefault();
    if (event.key === "Home") {
      setWidth(MIN_WIDTH);
    } else if (event.key === "End") {
      setWidth(clampWidth(MAX_WIDTH));
    } else {
      setWidth((current) => clampWidth(current + direction * RESIZE_STEP));
    }
  };

  return (
    <aside
      aria-label="Recent workflow runs"
      aria-hidden={!open}
      inert={!open}
      style={{ "--global-workflow-drawer-width": `${width}px` } as CSSProperties}
      className={`sticky top-0 z-40 flex h-dvh shrink-0 flex-col overflow-hidden bg-[var(--bo-panel)] transition-[width,box-shadow] duration-200 ease-out ${open ? "w-[min(var(--global-workflow-drawer-width),calc(100vw-2rem))] border-l border-[color:var(--bo-border)] shadow-[var(--bo-popover-shadow)]" : "pointer-events-none w-0 shadow-none"}`}
    >
      <div
        role="separator"
        aria-label="Resize workflow drawer"
        aria-orientation="vertical"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={Math.round(width)}
        tabIndex={open ? 0 : -1}
        onDoubleClick={() => {
          setWidth(DEFAULT_WIDTH);
        }}
        onKeyDown={resizeFromKeyboard}
        onPointerDown={(event) => {
          event.preventDefault();
          draggingRef.current = true;
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
        className="group absolute inset-y-0 left-0 hidden w-px -translate-x-px cursor-col-resize bg-[var(--bo-border-strong)] outline-none focus-visible:bg-[var(--bo-accent)] sm:block"
      >
        <span className="absolute inset-y-0 -left-5 w-10 bg-transparent transition-colors duration-150 group-hover:bg-[color:var(--bo-accent-bg)]/45" />
      </div>

      <header className="flex min-h-14 items-center justify-between gap-3 border-b border-[color:var(--bo-border)] px-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)] shadow-[inset_0_0_0_1px_var(--bo-border)]">
            <Activity className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-[9px] font-semibold tracking-[0.16em] text-[var(--bo-muted-2)] uppercase">
              Live activity
            </p>
            <h2 className="truncate text-xs font-semibold text-[var(--bo-fg)]">Recent workflows</h2>
          </div>
        </div>
        <button
          type="button"
          aria-label="Close workflow drawer"
          onClick={onClose}
          className="inline-flex size-10 items-center justify-center text-[var(--bo-muted)] transition-[background-color,color,scale] duration-150 hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96]"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </header>

      {open ? (
        <ClientOnly fallback={<DrawerState message="Mounting workflow database…" />}>
          {sourceState?.status === "ready" ? (
            <WorkflowDrawerErrorBoundary
              key={describeAutomationCollectionSource(sourceState.source).resourceKey}
              fallback={<DrawerState message="Workflow synchronization failed." tone="error" />}
            >
              <Suspense fallback={<DrawerState message="Mounting workflow database…" />}>
                <GlobalWorkflowDrawerData source={sourceState.source} />
              </Suspense>
            </WorkflowDrawerErrorBoundary>
          ) : (
            <DrawerState
              message={sourceState?.message ?? "Workflow activity is unavailable for this account."}
              tone={sourceState ? "error" : "muted"}
            />
          )}
        </ClientOnly>
      ) : null}
    </aside>
  );
}

class WorkflowDrawerErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function GlobalWorkflowDrawerData({ source }: { source: AutomationCollectionSource }) {
  const database = use(getAutomationBrowserDatabase(source));
  return <RecentWorkflowRuns database={database} source={source} />;
}

function RecentWorkflowRuns({
  database,
  source,
}: {
  database: AutomationBrowserDatabase;
  source: AutomationCollectionSource;
}) {
  const { collections, coordinator } = database;
  const statusQuery = useLiveQuery(
    (builder) => builder.from({ status: coordinator.internal.collection }),
    [coordinator.internal.collection],
  );
  const query = useLiveQuery(
    (builder) =>
      builder
        .from({ instance: collections.workflowInstances })
        .orderBy(({ instance }) => instance.updatedAt, "desc")
        .orderBy(({ instance }) => instance.id, "desc")
        .limit(30)
        .select(({ instance }) => ({
          id: instance.id,
          instanceId: instance.instanceId,
          workflowName: instance.workflowName,
          remoteWorkflowName: instance.remoteWorkflowName,
          status: instance.status,
          output: instance.output,
          errorName: instance.errorName,
          errorMessage: instance.errorMessage,
          createdAt: instance.createdAt,
          updatedAt: instance.updatedAt,
          steps: toArray(
            builder
              .from({ step: collections.workflowSteps })
              .where(({ step }) => eq(step.instanceRef, instance.id))
              .orderBy(({ step }) => step.createdAt, "asc")
              .orderBy(({ step }) => step.id, "asc")
              .select(({ step }) => ({
                id: step.id,
                stepKey: step.stepKey,
                parentStepKey: step.parentStepKey,
                name: step.name,
                type: step.type,
                // The workflow schema stores status as a string; the runner persists only these states.
                status: step.status as unknown as RecentWorkflowRun["steps"][number]["status"],
                attempts: step.attempts,
                errorMessage: step.errorMessage,
                waitEventType: step.waitEventType,
                result: step.result,
                createdAt: step.createdAt,
                updatedAt: step.updatedAt,
              })),
          ),
          workflowEvents: toArray(
            builder
              .from({ event: collections.workflowEvents })
              .where(({ event }) => eq(event.instanceRef, instance.id))
              .orderBy(({ event }) => event.createdAt, "asc")
              .orderBy(({ event }) => event.id, "asc")
              .select(({ event }) => ({
                id: event.id,
                actor: event.actor,
                type: event.type,
                payload: event.payload,
                createdAt: event.createdAt,
                deliveredAt: event.deliveredAt,
                consumedByStepKey: event.consumedByStepKey,
              })),
          ),
        })),
    [collections.workflowEvents, collections.workflowInstances, collections.workflowSteps],
  );
  const runs: RecentWorkflowRun[] = query.data ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRun = runs.find((run) => run.id === selectedId) ?? null;

  if (query.isLoading && runs.length === 0) {
    return <DrawerState message="Synchronizing recent workflows…" />;
  }
  const synchronizationStatus = statusQuery.data?.[0];
  if (query.isError || synchronizationStatus?.state === "failed") {
    return (
      <DrawerState
        message={synchronizationStatus?.error?.message ?? "Workflow synchronization failed."}
        tone="error"
      />
    );
  }
  if (runs.length === 0) {
    return <DrawerState message="No workflow runs yet. New runs will appear here live." />;
  }

  if (selectedRun) {
    return (
      <WorkflowRunDetail
        run={selectedRun}
        source={source}
        onBack={() => {
          setSelectedId(null);
        }}
      />
    );
  }

  return (
    <div className="backoffice-scroll min-h-0 flex-1 overflow-y-auto">
      {runs.map((run) => (
        <button
          key={run.id}
          type="button"
          onClick={() => {
            setSelectedId(run.id);
          }}
          className="flex min-h-16 w-full items-center gap-3 border-b border-[color:var(--bo-border)] px-3 py-2 text-left transition-[background-color,color] duration-150 hover:bg-[var(--bo-panel-2)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none focus-visible:ring-inset"
        >
          <StatusDot status={run.status} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold text-[var(--bo-fg)]">
              {run.remoteWorkflowName ?? run.workflowName}
            </p>
            <p className="mt-1 truncate font-mono text-[9px] text-[var(--bo-muted-2)]">
              {run.instanceId}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-[9px] font-semibold tracking-[0.1em] text-[var(--bo-muted)] uppercase">
              {run.status}
            </p>
            <p className="mt-1 text-[9px] text-[var(--bo-muted-2)] tabular-nums">
              {formatRelativeTime(run.updatedAt)}
            </p>
          </div>
          <ChevronRight className="size-3.5 shrink-0 text-[var(--bo-muted-2)]" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

function WorkflowRunDetail({
  run,
  source,
  onBack,
}: {
  run: RecentWorkflowRun;
  source: AutomationCollectionSource;
  onBack: () => void;
}) {
  const runtimeScope = backofficeRuntimeScopeFromResolvedScope(source.resolvedScope);
  const generatedUi = latestWorkflowGeneratedUi(run);
  const completedSteps = run.steps.filter((step) => step.status === "completed").length;
  const runError = workflowRunErrorText(run);
  return (
    <div className="backoffice-scroll min-h-0 overflow-y-auto p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <button
            type="button"
            aria-label="Back to recent workflows"
            onClick={onBack}
            className="inline-flex size-8 shrink-0 items-center justify-center text-[var(--bo-muted)] transition-[background-color,color,scale] duration-150 hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96]"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
          </button>
          <div className="min-w-0">
            <p className="text-[9px] font-semibold tracking-[0.16em] text-[var(--bo-muted-2)] uppercase">
              Run detail
            </p>
            <h3 className="mt-1 truncate text-sm font-semibold text-[var(--bo-fg)]">
              {run.remoteWorkflowName ?? run.workflowName}
            </h3>
          </div>
        </div>
        <span className="shrink-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[9px] font-semibold tracking-[0.1em] text-[var(--bo-muted)] uppercase">
          {run.status}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-px bg-[var(--bo-border)] shadow-[0_0_0_1px_var(--bo-border)]">
        <Metric label="Progress" value={`${completedSteps}/${run.steps.length}`} />
        <Metric label="Updated" value={formatRelativeTime(run.updatedAt)} />
      </div>

      {runError ? (
        <section
          aria-labelledby="global-workflow-error-title"
          className="mt-4 border border-red-500/35 bg-red-500/8 p-3"
        >
          <h4
            id="global-workflow-error-title"
            className="text-[9px] font-semibold tracking-[0.16em] text-[var(--bo-failed)] uppercase"
          >
            Run error
          </h4>
          <p className="mt-2 font-mono text-xs leading-5 whitespace-pre-wrap text-[var(--bo-failed)]">
            {runError}
          </p>
        </section>
      ) : null}

      <section className="mt-5" aria-labelledby="global-workflow-progress-title">
        <h4
          id="global-workflow-progress-title"
          className="text-[9px] font-semibold tracking-[0.16em] text-[var(--bo-muted-2)] uppercase"
        >
          Progress
        </h4>
        <ol className="mt-2 space-y-1">
          {run.steps.length ? (
            run.steps.map((step) => (
              <li
                key={step.id}
                className="flex gap-3 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-2.5"
              >
                <StatusDot status={step.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-xs font-medium text-[var(--bo-fg)]">{step.name}</p>
                    <span className="text-[9px] text-[var(--bo-muted-2)] tabular-nums">
                      {step.attempts > 1 ? `${step.attempts} attempts` : step.status}
                    </span>
                  </div>
                  {step.waitEventType ? (
                    <p className="mt-1 text-[10px] text-[var(--bo-waiting)]">
                      Waiting for {step.waitEventType}
                    </p>
                  ) : null}
                  {step.errorMessage ? (
                    <p className="mt-1 text-[10px] text-[var(--bo-failed)]">{step.errorMessage}</p>
                  ) : null}
                </div>
              </li>
            ))
          ) : (
            <p className="border border-dashed border-[color:var(--bo-border)] p-3 text-xs text-[var(--bo-muted)]">
              The run has not committed a step yet.
            </p>
          )}
        </ol>
      </section>

      {generatedUi ? (
        <section className="mt-5" aria-labelledby="global-workflow-ui-title">
          <div className="mb-2 flex items-center gap-2">
            <Workflow className="size-3.5 text-[var(--bo-accent-fg)]" aria-hidden="true" />
            <h4
              id="global-workflow-ui-title"
              className="text-[9px] font-semibold tracking-[0.16em] text-[var(--bo-muted-2)] uppercase"
            >
              Generated interface
            </h4>
          </div>
          <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
            {generatedUi.type === "step" ? (
              <WorkflowStepGeneratedUi
                state={workflowStepGeneratedUiState(generatedUi.step)}
                workflowEvents={run.workflowEvents}
                workflowRunRecordId={run.id}
                currentScope={
                  source.resolvedScope.kind !== "system" ? source.resolvedScope : undefined
                }
                workflowName={run.remoteWorkflowName ?? run.workflowName}
                workflowInstanceId={run.instanceId}
                waitingEventTypes={currentWorkflowWaitingEventTypes(run.steps)}
                workflowEventSender={async ({
                  eventId,
                  workflowName,
                  instanceId,
                  eventType,
                  payload,
                }) => {
                  await sendBackofficeWorkflowEvent({
                    eventId,
                    reference: {
                      scope: runtimeScope,
                      workflowName,
                      instanceId,
                    },
                    eventType,
                    payload,
                  });
                }}
              />
            ) : generatedUi.parsed.kind === "valid" ? (
              <BackofficeUiErrorBoundary
                fallback={
                  <DrawerState
                    message="A generated component failed while rendering."
                    tone="error"
                  />
                }
              >
                <BackofficeUiRenderer ui={generatedUi.parsed.value.$ui} />
              </BackofficeUiErrorBoundary>
            ) : (
              <DrawerState message={generatedUi.parsed.message} tone="error" />
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function latestWorkflowGeneratedUi(run: RecentWorkflowRun) {
  const parsedOutput = parseBackofficeUiResult(run.output);
  if (parsedOutput.kind !== "ordinary") {
    return { type: "output" as const, parsed: parsedOutput };
  }

  for (let index = run.steps.length - 1; index >= 0; index -= 1) {
    const step = run.steps[index];
    if (step?.status !== "completed") {
      continue;
    }
    const parsed = parseBackofficeUiResult(step.result);
    if (parsed.kind !== "ordinary") {
      return { type: "step" as const, step };
    }
  }
  return null;
}

function workflowStepGeneratedUiState(
  step: RecentWorkflowRun["steps"][number],
): WorkflowStepRunState {
  return {
    stepRecordId: step.id,
    status: step.status,
    attempts: step.attempts,
    completedAt: step.status === "completed" ? step.updatedAt : undefined,
    result: step.result,
    error: step.errorMessage ?? undefined,
    waitEventType: step.waitEventType ?? undefined,
    emissionCount: 0,
    current: false,
  };
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[var(--bo-panel-2)] p-3">
      <p className="text-[9px] tracking-[0.14em] text-[var(--bo-muted-2)] uppercase">{label}</p>
      <p className="mt-1 text-xs font-semibold text-[var(--bo-fg)] tabular-nums">{value}</p>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "active"
      ? "bg-[var(--bo-live)] animate-pulse"
      : status === "waiting" || status === "paused"
        ? "bg-[var(--bo-waiting)]"
        : status === "complete" || status === "completed"
          ? "bg-emerald-500"
          : status === "errored" || status === "terminated"
            ? "bg-[var(--bo-failed)]"
            : "bg-[var(--bo-muted-2)]";
  return <span className={`mt-1 size-2 shrink-0 rounded-full ${color}`} aria-hidden="true" />;
}

function DrawerState({ message, tone = "muted" }: { message: string; tone?: "muted" | "error" }) {
  return (
    <div
      className={`m-4 border border-dashed border-[color:var(--bo-border)] p-4 text-xs leading-relaxed ${tone === "error" ? "text-[var(--bo-failed)]" : "text-[var(--bo-muted)]"}`}
    >
      <Clock3 className="mb-2 size-4" aria-hidden="true" />
      {message}
    </div>
  );
}

function formatRelativeTime(value: Date | string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    return "now";
  }
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) {
    return "now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

function subscribeToDrawerWidth(listener: () => void) {
  drawerWidthListeners.add(listener);
  return () => {
    drawerWidthListeners.delete(listener);
  };
}

function getDrawerWidthSnapshot(): number {
  drawerWidthSnapshot ??= readStoredWidth();
  return drawerWidthSnapshot;
}

function getServerDrawerWidthSnapshot(): number {
  return DEFAULT_WIDTH;
}

function setDrawerWidthSnapshot(width: number) {
  if (drawerWidthSnapshot === width) {
    return;
  }
  drawerWidthSnapshot = width;
  for (const listener of drawerWidthListeners) {
    listener();
  }
}

function readStoredWidth(): number {
  if (typeof window === "undefined") {
    return DEFAULT_WIDTH;
  }
  try {
    const value = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value >= MIN_WIDTH
      ? Math.min(MAX_WIDTH, value)
      : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}
