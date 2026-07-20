/*
 * The companion panel for a codemode run — the code an agent ran via
 * `execCodeMode`. There is no file on disk to load: the `execCodeMode` tool
 * parses its own output server-side and returns the code plus, when the code
 * defined a workflow, its graph.
 *
 *   - A workflow run feeds the graph + source into the same {@link WorkflowWorkbench}
 *     the workflows page uses, via a synthetic read-only source, so the view
 *     matches it node for node — only run/save are dropped (there is no file to
 *     execute or persist), and the run's captured output is shown beneath the panels.
 *   - A plain script run (no workflow) has no graph worth showing, so it renders
 *     the read-only code beside its captured output.
 */

import { Terminal } from "lucide-react";

import { CadenceCodeEditor } from "@/components/cadence/code-editor";
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

  return (
    <CompanionPanel
      icon={<Terminal className="h-4 w-4 shrink-0 text-[var(--cad-brass)]" />}
      title={active.title}
      badge="codemode"
      onClose={onClose}
      flush
    >
      <CodemodeTabs entries={entries} activeIndex={activeIndex} onSelect={onSelectTab} />
      {active.isWorkflow ? (
        <CodemodeWorkflowView key={active.id} entry={active} orgId={orgId} />
      ) : (
        <CodemodeScriptView key={active.id} entry={active} />
      )}
    </CompanionPanel>
  );
}

/** A workflow run: the full workbench (graph + code) with live run highlighting. */
function CodemodeWorkflowView({ entry, orgId }: { entry: CodemodeEntry; orgId: string | null }) {
  // A synthetic source so the workbench can render the code beside the graph.
  // There is no file behind it, so it is read-only and cannot be run.
  const source: WorkflowSource = {
    absolutePath: "",
    path: entry.title,
    engine: "codemode",
    body: entry.code,
    readOnly: true,
    inputFields: [],
  };

  return (
    <WorkflowWorkbench
      workflow={entry.title}
      source={source}
      loaderGraph={entry.graph}
      events={[]}
      orgId={orgId}
      readOnly
      canRun={false}
      flushHeader
      // Subscribe to the run the agent scheduled so the graph lights up live.
      trackInstanceId={entry.run?.instanceId}
      runWorkflowName={entry.run?.workflowName}
      footer={entry.output ? <CodemodeOutput output={entry.output} /> : null}
    />
  );
}

/** A plain script run (no workflow): the read-only code beside its captured output. */
function CodemodeScriptView({ entry }: { entry: CodemodeEntry }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pt-4 pb-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[color:var(--cad-line)]">
        <CadenceCodeEditor
          value={entry.code}
          engine="codemode"
          readOnly
          onChange={() => {}}
          onSave={() => {}}
        />
      </div>
      {entry.output ? <CodemodeOutput output={entry.output} /> : null}
    </div>
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
          onClick={() => {
            onSelect(index);
          }}
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
