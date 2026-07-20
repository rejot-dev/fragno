import { AlertTriangle, RefreshCw, Workflow } from "lucide-react";
import { useEffect } from "react";
import { useLoaderData, useRevalidator, useSearchParams } from "react-router";
import type { ShouldRevalidateFunctionArgs } from "react-router";

import type { WorkflowGraph } from "@fragno-dev/workflow-visualizer";

import { CadenceGhostButton } from "@/components/cadence";
import { WorkflowView } from "@/components/cadence/workflow-graph";
import {
  DiagnosticsBanner,
  WorkflowWorkbench,
} from "@/components/cadence/workflow-graph/workflow-workbench";
import { getAuthMe } from "@/fragno/auth/auth-server";
import { cn } from "@/lib/utils";
import { writeAutomationScriptSource } from "@/routes/backoffice/automations/data.server";

import type { Route } from "./+types/workflows";
import { buildWorkflowGraphView, previewWorkflowGraph, runWorkflow } from "./workflow-graph.server";

/** Fill the whole main area — see {@link CadenceShell}. */
export const handle = { fullBleed: true };

/**
 * Visualizes a single automation workflow, from its inputs (the events and
 * router rules that trigger it) through to its output (the step sequence).
 * Derived live from the automation source — pick a workflow from the selector,
 * edit its code next to the graph and watch the graph re-derive as you type,
 * and use "Go live" to auto-refresh as the underlying files change.
 */
export async function loader({ request, context, url }: Route.LoaderArgs) {
  const me = await getAuthMe(request, context);
  const orgId = me?.activeOrganization?.organization?.id;
  if (!orgId) {
    return { workflows: [], selected: null, graph: null, source: null, events: [], orgId: null };
  }

  const workflowName = url.searchParams.get("workflow") ?? undefined;
  const view = await buildWorkflowGraphView({ request, context, orgId, workflowName });
  return { ...view, orgId };
}

/**
 * `preview` submissions only re-parse the graph for unsaved edits — they must
 * not trigger a loader revalidation (which would re-read the files from disk and
 * fight the editor). Everything else (saves) revalidates as usual.
 */
export function shouldRevalidate({
  formData,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  const intent = formData?.get("intent");
  // `preview` re-parses unsaved edits and `run` kicks off an execution — neither
  // should re-read files from disk (which would fight the editor / remount).
  if (intent === "preview" || intent === "run") {
    return false;
  }
  return defaultShouldRevalidate;
}

export async function action({ request, context }: Route.ActionArgs) {
  const me = await getAuthMe(request, context);
  const orgId = me?.activeOrganization?.organization?.id;
  if (!orgId) {
    return { ok: false as const, error: "No active organization." };
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const workflow = String(form.get("workflow") ?? "");
  const absolutePath = String(form.get("path") ?? "");
  const body = String(form.get("body") ?? "");

  if (intent === "save") {
    const result = await writeAutomationScriptSource({
      request,
      context,
      orgId,
      absolutePath,
      body,
    });
    return { ok: result.ok, error: result.error };
  }

  if (intent === "preview") {
    if (!workflow || !absolutePath) {
      return { ok: false as const, error: "Missing workflow or path." };
    }
    const { graph } = await previewWorkflowGraph({
      request,
      context,
      orgId,
      workflowName: workflow,
      absolutePath,
      body,
    });
    return { ok: true as const, graph };
  }

  if (intent === "run") {
    if (!workflow) {
      return { ok: false as const, error: "Missing workflow." };
    }
    const source = String(form.get("source") ?? "").trim() || "manual";
    const eventType = String(form.get("eventType") ?? "").trim();
    if (!eventType) {
      return { ok: false as const, error: "An event type is required." };
    }
    const payloadRaw = String(form.get("payload") ?? "").trim();
    let payload: Record<string, unknown>;
    try {
      payload = payloadRaw ? JSON.parse(payloadRaw) : {};
    } catch (error) {
      return {
        ok: false as const,
        error: `Payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return { ok: false as const, error: "Payload must be a JSON object." };
    }

    const result = await runWorkflow({
      request,
      context,
      orgId,
      workflowName: workflow,
      source,
      eventType,
      payload,
    });
    if (!result.ok) {
      return { ok: false as const, error: result.error };
    }
    return {
      ok: true as const,
      intent: "run" as const,
      instanceId: result.instanceId,
      runWorkflowName: result.runWorkflowName,
    };
  }

  return { ok: false as const, error: `Unknown intent: ${intent}` };
}

const LIVE_INTERVAL_MS = 3500;

export default function WorkflowsPage() {
  const { workflows, selected, graph, source, events, orgId } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const revalidator = useRevalidator();
  const live = searchParams.get("live") === "1";
  useLiveRevalidate(live);

  const setParam = (key: string, value: string | null) => {
    setSearchParams(
      (prev) => {
        if (value === null) {
          prev.delete(key);
        } else {
          prev.set(key, value);
        }
        return prev;
      },
      { replace: true, preventScrollReset: true },
    );
  };

  if (!graph) {
    return (
      <div className="flex min-h-full flex-1 p-4">
        <EmptyState message="No active organization. Pick one from the backoffice to see its workflows." />
      </div>
    );
  }
  if (workflows.length === 0) {
    return (
      <div className="flex min-h-full flex-1 p-4">
        <EmptyState message="No automation workflows found in this workspace." />
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-1">
      <WorkflowSelector
        workflows={workflows}
        selected={selected}
        onSelect={(name) => {
          setParam("workflow", name);
        }}
        onRefresh={() => void revalidator.revalidate()}
        refreshing={revalidator.state !== "idle"}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selected && source ? (
          <WorkflowWorkbench
            key={source.absolutePath}
            workflow={selected}
            source={source}
            loaderGraph={graph}
            events={events}
            orgId={orgId}
            flushHeader
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col p-4">
            <GraphPanel graph={graph} />
          </div>
        )}
      </div>
    </div>
  );
}

function GraphPanel({ graph }: { graph: WorkflowGraph }) {
  const errors = graph.diagnostics.filter((d) => d.severity === "error");
  const warnings = graph.diagnostics.filter((d) => d.severity === "warning");
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {errors.length + warnings.length > 0 ? (
        <DiagnosticsBanner diagnostics={[...errors, ...warnings]} />
      ) : null}
      <WorkflowView graph={graph} />
    </div>
  );
}

function WorkflowSelector({
  workflows,
  selected,
  onSelect,
  onRefresh,
  refreshing,
}: {
  workflows: NonNullable<Awaited<ReturnType<typeof loader>>["workflows"]>;
  selected: string | null;
  onSelect: (name: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col self-stretch border-r border-[color:var(--cad-line)] bg-[var(--cad-bg)]">
      <div className="box-content flex h-14 shrink-0 items-center justify-between border-b border-[color:var(--cad-line)] px-3">
        <span className="cad-eyebrow text-[var(--cad-muted-2)]">Workflows</span>
        <CadenceGhostButton
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="h-8 w-8 shrink-0 px-0 py-0"
          aria-label="Refresh workflows"
          title="Refresh"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
        </CadenceGhostButton>
      </div>

      <nav className="cad-scroll flex flex-1 flex-col gap-1 overflow-y-auto p-3">
        {workflows.map((workflow) => {
          const isActive = workflow.name === selected;
          const Icon = workflow.broken ? AlertTriangle : Workflow;
          return (
            <button
              key={workflow.name}
              type="button"
              onClick={() => {
                onSelect(workflow.name);
              }}
              className={cn(
                "group flex items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors",
                isActive
                  ? "border-[color:var(--cad-line)] bg-[var(--cad-panel)] shadow-[0_1px_2px_oklch(0.3_0.02_60/0.06)]"
                  : "border-transparent hover:bg-[var(--cad-panel)]/60",
              )}
            >
              <Icon
                className={cn(
                  "h-5 w-5 shrink-0 transition-colors",
                  workflow.broken
                    ? "text-[var(--cad-rose)]"
                    : isActive
                      ? "text-[var(--cad-fg)]"
                      : "text-[var(--cad-muted-2)] group-hover:text-[var(--cad-fg)]",
                )}
                strokeWidth={2}
              />
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "flex items-center gap-1.5 text-xs",
                    isActive
                      ? "font-semibold text-[var(--cad-fg)]"
                      : "font-medium text-[var(--cad-muted)] group-hover:text-[var(--cad-fg)]",
                  )}
                >
                  <span className="truncate">{workflow.label}</span>
                  {workflow.broken ? (
                    <span className="cad-eyebrow shrink-0 rounded-sm bg-[var(--cad-rose-bg)] px-1 py-0.5 text-[8px] text-[var(--cad-rose)]">
                      error
                    </span>
                  ) : workflow.remote ? (
                    <span className="cad-eyebrow shrink-0 rounded-sm bg-[var(--cad-panel-2)] px-1 py-0.5 text-[8px] text-[var(--cad-muted-2)]">
                      remote
                    </span>
                  ) : null}
                </span>
                <span className="cad-mono block truncate text-[10px] tracking-wide text-[var(--cad-muted-2)]">
                  {workflow.broken
                    ? "parse error"
                    : `${workflow.stepCount} step${workflow.stepCount === 1 ? "" : "s"}`}
                </span>
              </span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-1 items-center justify-center rounded-xl border border-[color:var(--cad-line)] bg-[var(--cad-panel)] p-12">
      <p className="text-sm text-[var(--cad-muted)]">{message}</p>
    </div>
  );
}

function useLiveRevalidate(enabled: boolean) {
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    const id = setInterval(() => {
      if (revalidator.state === "idle") {
        void revalidator.revalidate();
      }
    }, LIVE_INTERVAL_MS);
    return () => {
      clearInterval(id);
    };
  }, [enabled, revalidator]);
}
