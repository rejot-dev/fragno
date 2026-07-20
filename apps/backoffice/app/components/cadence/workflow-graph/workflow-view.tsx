/*
 * The single way to show a workflow. It renders the graph, the source code, or
 * both side by side, with one top bar across the top holding the caller's
 * controls (run, save, status…) and the segmented view toggle. The graph and
 * code surfaces are otherwise self-contained, so this composes anywhere a
 * workflow needs to be shown — the editing workbench passes a toolbar of
 * actions, while a read-only viewer just hands over a graph and some source.
 */

import { Code2, Columns2, Workflow } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { WorkflowGraph } from "@fragno-dev/workflow-visualizer";

import { CadenceCodeEditor, type CodeEditorEngine } from "@/components/cadence/code-editor";
import { cn } from "@/lib/utils";

import type { NodeRunState } from "./flow";
import { PipelineGraph } from "./pipeline-graph";

export type WorkflowViewMode = "graph" | "code" | "split";

/** The source side of the view. Omit it to show the graph on its own. */
export type WorkflowViewCode = {
  value: string;
  engine: CodeEditorEngine;
  /** Read-only by default; pass `onChange` to make it editable. */
  onChange?: (next: string) => void;
  /** Invoked on Cmd/Ctrl+S inside the editor. */
  onSave?: () => void;
};

export function WorkflowView({
  graph,
  runState,
  toolbar,
  code,
  defaultMode,
  className,
  flushHeader,
  banner,
  footer,
}: {
  graph: WorkflowGraph;
  /** Node id -> live run state, forwarded to the graph for highlighting. */
  runState?: Map<string, NodeRunState>;
  /** Controls for the single top bar (run, save, status…), left of the toggle. */
  toolbar?: ReactNode;
  /** When provided, the Code and Both views become available. */
  code?: WorkflowViewCode;
  defaultMode?: WorkflowViewMode;
  className?: string;
  /**
   * Render the top bar as a flush, full-width header band (`h-14` + bottom
   * border) instead of a floating card, so it lines up with an adjacent sidebar
   * header. The body (banner, panels, footer) then carries its own padding.
   */
  flushHeader?: boolean;
  /** Slot above the panels (diagnostics / error notices). */
  banner?: ReactNode;
  /** Slot below the panels (e.g. an emissions log). */
  footer?: ReactNode;
}) {
  const [mode, setMode] = useState<WorkflowViewMode>(defaultMode ?? (code ? "split" : "graph"));

  // Without code there is nothing to toggle to — the graph fills the surface.
  const effective: WorkflowViewMode = code ? mode : "graph";
  const showCode = code !== undefined && (effective === "code" || effective === "split");
  const showGraph = effective === "graph" || effective === "split";

  // The bar carries the caller's controls and the view toggle. With neither
  // (a plain graph) there is nothing to show, so it collapses away.
  const showBar = toolbar !== undefined || code !== undefined;

  const bar = showBar ? (
    <div
      className={cn(
        "flex shrink-0 items-center gap-3",
        flushHeader
          ? "box-content h-14 border-b border-[color:var(--cad-line)] px-4"
          : "rounded-xl border border-[color:var(--cad-line)] bg-[var(--cad-panel)] px-3 py-2",
      )}
    >
      <div className="min-w-0 flex-1">{toolbar}</div>
      {code ? <ModeToggle mode={effective} onChange={setMode} /> : null}
    </div>
  ) : null;

  const panels = (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      {showCode && code ? <CodePanel code={code} /> : null}
      {showGraph ? <GraphPanel graph={graph} runState={runState} /> : null}
    </div>
  );

  // Flush mode: the bar spans the top as a header band, everything else lives in
  // a padded body so it aligns with a neighbouring sidebar's header.
  if (flushHeader) {
    return (
      <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
        {bar}
        <div className="flex min-h-0 flex-1 flex-col">
          {banner}
          {panels}
          {footer}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-3", className)}>
      {banner}
      {bar}
      {panels}
      {footer}
    </div>
  );
}

function CodePanel({ code }: { code: WorkflowViewCode }) {
  return (
    <div className="flex min-h-[440px] flex-1 flex-col overflow-hidden border-r border-[color:var(--cad-line)] bg-[var(--cad-panel)] lg:min-h-0">
      <CadenceCodeEditor
        value={code.value}
        onChange={code.onChange ?? noop}
        engine={code.engine}
        readOnly={code.onChange === undefined}
        onSave={code.onSave ?? noop}
      />
    </div>
  );
}

function GraphPanel({
  graph,
  runState,
}: {
  graph: WorkflowGraph;
  runState?: Map<string, NodeRunState>;
}) {
  return (
    <div className="flex min-h-[440px] flex-1 flex-col overflow-hidden bg-[var(--cad-bg-2)] lg:min-h-0">
      <div className="relative min-h-0 flex-1">
        <PipelineGraph graph={graph} runState={runState} />
      </div>
    </div>
  );
}

const MODES: { mode: WorkflowViewMode; label: string; icon: typeof Workflow }[] = [
  { mode: "graph", label: "Graph", icon: Workflow },
  { mode: "code", label: "Code", icon: Code2 },
  { mode: "split", label: "Both", icon: Columns2 },
];

function ModeToggle({
  mode,
  onChange,
}: {
  mode: WorkflowViewMode;
  onChange: (mode: WorkflowViewMode) => void;
}) {
  return (
    <div className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-[color:var(--cad-line)] bg-[var(--cad-panel-2)] p-0.5">
      {MODES.map(({ mode: value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          onClick={() => {
            onChange(value);
          }}
          aria-pressed={mode === value}
          className={cn(
            "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors",
            mode === value
              ? "bg-[var(--cad-panel)] text-[var(--cad-fg)] shadow-[var(--cad-shadow)]"
              : "text-[var(--cad-muted-2)] hover:text-[var(--cad-fg)]",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}

function noop() {}
