import { Code2, Columns2, Workflow as WorkflowIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useSearchParams } from "react-router";

import { visualizeWorkflowSource, type SourceRange } from "@fragno-dev/workflow-visualizer-tokens";

import {
  SCRIPT_VIEW_MODE_SEARCH_PARAM,
  scriptViewModeFromSearchParam,
  searchParamsWithScriptViewMode,
  type ScriptViewMode,
} from "./script-view-mode";
import { ScriptWorkflowGraph } from "./workflow-graph";

const SCRIPT_VIEW_OPTIONS: Array<{
  mode: ScriptViewMode;
  label: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { mode: "code", label: "Code", icon: Code2 },
  { mode: "graph", label: "Graph", icon: WorkflowIcon },
  { mode: "split", label: "Both", icon: Columns2 },
];

export function ScriptSourcePanel({
  absolutePath,
  source,
}: {
  absolutePath: string;
  source: { script: string | null; scriptError: string | null };
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const viewMode = scriptViewModeFromSearchParam(searchParams.get(SCRIPT_VIEW_MODE_SEARCH_PARAM));
  const script = source.script ?? "";
  const [selectedSource, setSelectedSource] = useState<SourceRange>();
  const currentSourceSelection = selectedSource?.path === absolutePath ? selectedSource : undefined;
  const visualization = useMemo(
    () => visualizeWorkflowSource(absolutePath, script),
    [absolutePath, script],
  );

  if (source.scriptError) {
    return null;
  }

  const showCode = viewMode === "code" || viewMode === "split";
  const showGraph = viewMode === "graph" || viewMode === "split";

  return (
    <div className="overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[color:var(--bo-border)] px-4 py-3">
        <p className="min-w-0 flex-1 font-mono text-[11px] break-all text-[var(--bo-muted-2)]">
          {absolutePath}
        </p>
        <ScriptViewToggle
          viewMode={viewMode}
          onViewModeChange={(mode) => {
            setSearchParams(
              (currentSearchParams) => searchParamsWithScriptViewMode(currentSearchParams, mode),
              { preventScrollReset: true, replace: true },
            );
          }}
        />
      </div>

      <div className={viewMode === "split" ? "grid min-h-0 lg:grid-cols-2" : "min-h-0"}>
        {showCode ? (
          <ScriptCodeView
            script={script}
            split={viewMode === "split"}
            selectedSource={currentSourceSelection}
          />
        ) : null}
        {showGraph ? (
          <ScriptWorkflowGraph
            visualization={visualization}
            onSourceSelect={(selectedRange) => {
              setSelectedSource(selectedRange);
              if (viewMode === "graph") {
                setSearchParams(
                  (currentSearchParams) =>
                    searchParamsWithScriptViewMode(currentSearchParams, "split"),
                  { preventScrollReset: true, replace: true },
                );
              }
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function ScriptViewToggle({
  viewMode,
  onViewModeChange,
}: {
  viewMode: ScriptViewMode;
  onViewModeChange: (mode: ScriptViewMode) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Script view"
      className="flex shrink-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-0.5"
    >
      {SCRIPT_VIEW_OPTIONS.map(({ mode, label, icon: Icon }) => (
        <button
          key={mode}
          type="button"
          aria-pressed={viewMode === mode}
          onClick={() => {
            onViewModeChange(mode);
          }}
          className={
            viewMode === mode
              ? "flex items-center gap-1.5 bg-[var(--bo-panel)] px-2.5 py-1.5 text-[10px] font-semibold tracking-[0.12em] text-[var(--bo-fg)] uppercase shadow-sm"
              : "flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-semibold tracking-[0.12em] text-[var(--bo-muted-2)] uppercase transition-colors hover:text-[var(--bo-fg)]"
          }
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}

function ScriptCodeView({
  script,
  split,
  selectedSource,
}: {
  script: string;
  split: boolean;
  selectedSource?: SourceRange;
}) {
  const selectionRef = useRef<HTMLElement>(null);
  const selectionStart = Math.max(0, Math.min(script.length, selectedSource?.start.offset ?? 0));
  const selectionEnd = Math.max(
    selectionStart,
    Math.min(script.length, selectedSource?.end.offset ?? selectionStart),
  );
  const hasSelection = selectionEnd > selectionStart;

  useEffect(() => {
    if (hasSelection) {
      selectionRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [hasSelection, selectionStart, selectionEnd]);

  return (
    <pre
      className={`backoffice-scroll max-h-[calc(100vh-10rem)] min-h-[36rem] overflow-auto px-4 py-4 font-mono text-xs break-words whitespace-pre-wrap text-[var(--bo-fg)] ${split ? "border-b border-[color:var(--bo-border)] lg:border-r lg:border-b-0" : ""}`}
    >
      <code>
        {script ? (
          hasSelection ? (
            <>
              {script.slice(0, selectionStart)}
              <mark
                ref={selectionRef}
                className="bg-amber-300/35 text-inherit outline outline-1 outline-amber-500/50 dark:bg-amber-300/20"
              >
                {script.slice(selectionStart, selectionEnd)}
              </mark>
              {script.slice(selectionEnd)}
            </>
          ) : (
            script
          )
        ) : (
          "# Empty script"
        )}
      </code>
    </pre>
  );
}
