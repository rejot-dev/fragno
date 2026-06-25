/*
 * The companion panel for a codemode workflow — the workflow an agent ran via
 * `execCodeMode`. There is no file on disk to load: the `execCodeMode` tool
 * parses its own output server-side and returns the graph plus the source it
 * ran. We feed those into the same {@link WorkflowWorkbench} the workflows page
 * uses, via a synthetic read-only source, so the codemode view matches it node
 * for node — only run/save are dropped (there is no file to execute or persist),
 * and the run's captured output is shown beneath the panels.
 */

import { Terminal } from "lucide-react";

import { WorkflowWorkbench } from "@/components/cadence/workflow-graph/workflow-workbench";
import { cn } from "@/lib/utils";
import type { WorkflowSource } from "@/routes/cadence/workflow-graph.server";

import { CompanionPanel } from "./companion-panel";
import type { CodemodeEntry } from "./prompt-context";

export function CodemodeWorkflowPanel({
  entries,
  activeIndex,
  orgId,
  onSelectTab,
  onClose,
}: {
  /** One tab per `execCodeMode` run, oldest first. */
  entries: CodemodeEntry[];
  activeIndex: number;
  /** The active org, for subscribing to the run's live progress. */
  orgId: string | null;
  onSelectTab: (index: number) => void;
  onClose: () => void;
}) {
  const active = entries[activeIndex] ?? entries[0];
  if (!active) {
    return null;
  }

  // A synthetic source so the workbench can render the code beside the graph.
  // There is no file behind it, so it is read-only and cannot be run.
  const source: WorkflowSource = {
    absolutePath: "",
    path: active.title,
    engine: "codemode",
    body: active.code,
    readOnly: true,
    inputFields: [],
  };

  return (
    <CompanionPanel
      icon={<Terminal className="h-4 w-4 shrink-0 text-[var(--cad-brass)]" />}
      title={active.title}
      badge="codemode"
      onClose={onClose}
      flush
    >
      <CodemodeTabs entries={entries} activeIndex={activeIndex} onSelect={onSelectTab} />
      <WorkflowWorkbench
        // Remount per tab so the workbench's view-mode/parse state resets cleanly.
        key={active.id}
        workflow={active.title}
        source={source}
        loaderGraph={active.graph}
        events={[]}
        orgId={orgId}
        readOnly
        canRun={false}
        flushHeader
        // Subscribe to the run the agent scheduled so the graph lights up live.
        trackInstanceId={active.run?.instanceId}
        runWorkflowName={active.run?.workflowName}
        footer={active.output ? <CodemodeOutput output={active.output} /> : null}
      />
    </CompanionPanel>
  );
}

/** One tab per codemode run; clicking switches which run the panel shows. */
function CodemodeTabs({
  entries,
  activeIndex,
  onSelect,
}: {
  entries: CodemodeEntry[];
  activeIndex: number;
  onSelect: (index: number) => void;
}) {
  return (
    <div className="cad-scroll flex shrink-0 items-center gap-1 overflow-x-auto px-4 pt-4 pb-3">
      {entries.map((entry, index) => (
        <button
          key={entry.id}
          type="button"
          onClick={() => onSelect(index)}
          aria-pressed={index === activeIndex}
          title={entry.title}
          className={cn(
            "flex max-w-[12rem] shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors",
            index === activeIndex
              ? "border-[color:var(--cad-line)] bg-[var(--cad-panel)] text-[var(--cad-fg)] shadow-[var(--cad-shadow)]"
              : "border-transparent text-[var(--cad-muted-2)] hover:bg-[var(--cad-panel-2)] hover:text-[var(--cad-fg)]",
          )}
        >
          <Terminal className="h-3 w-3 shrink-0 text-[var(--cad-brass)]" />
          <span className="truncate">{entry.title}</span>
        </button>
      ))}
    </div>
  );
}

/** The codemode run output (console logs, return value, or error) under the panels. */
function CodemodeOutput({ output }: { output: string }) {
  return (
    <div className="cad-scroll max-h-48 shrink-0 overflow-y-auto rounded-xl border border-[color:var(--cad-line)] bg-[var(--cad-panel)] px-3 py-2">
      <p className="cad-eyebrow mb-1.5 text-[var(--cad-muted-2)]">Output</p>
      {output.trim() ? (
        <pre className="cad-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-[var(--cad-muted)]">
          {output}
        </pre>
      ) : (
        <p className="cad-mono text-[11px] text-[var(--cad-muted-2)]">No output.</p>
      )}
    </div>
  );
}
